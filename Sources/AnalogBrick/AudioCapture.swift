import AppKit
import CoreMedia
import CoreAudio
import ScreenCaptureKit
import BrickCore

/// Listens to Spotify's audio output only (ScreenCaptureKit app-filtered audio) and turns it into
/// 30 Hz analysis frames for the music-reactive visuals. Nothing is recorded or stored.
///
/// Needs the Screen Recording permission. Without it, `onStatus(false, "permission")` is reported and
/// the visuals fall back to a synthetic rhythm while Spotify is playing.
final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Called on the main queue ~30×/s while audio arrives.
    var onFrame: ((AudioFrame) -> Void)?
    /// Called on the main queue: (available, reason) — reason: ok | permission | spotify-not-running | unsupported | error.
    var onStatus: ((Bool, String) -> Void)?

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "analogbrick.audio", qos: .userInteractive)
    private var analyzer: AudioAnalyzer?
    private var timer: DispatchSourceTimer?
    private var lastSampleAt: CFTimeInterval = 0
    private var mono: [Float] = []
    private var running = false
    private var starting = false
    private var restartAttempts = 0

    static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    /// Shows the system prompt the first time; afterwards macOS only offers System Settings.
    @discardableResult
    static func requestPermission() -> Bool { CGRequestScreenCaptureAccess() }

    static func openPrivacySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func start() {
        guard !running, !starting else { return }
        guard AudioCapture.hasPermission else {
            report(false, "permission")
            return
        }
        starting = true
        Task { [weak self] in
            await self?.startStream()
        }
    }

    @MainActor
    private func startStream() async {
        defer { starting = false }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                report(false, "error")
                return
            }
            let apps = content.applications.filter { $0.bundleIdentifier == SpotifyController.bundleID }
            guard !apps.isEmpty else {
                report(false, "spotify-not-running")
                return
            }
            let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            // We only want audio; keep the (mandatory) video stream as small and slow as possible.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false
            config.queueDepth = 3

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await stream.startCapture()
            self.stream = stream
            running = true
            restartAttempts = 0
            startTimer()
            report(true, "ok")
            Log.audio.info("Audio capture started")
        } catch {
            Log.audio.error("Audio capture failed: \(error.localizedDescription, privacy: .public)")
            report(false, AudioCapture.hasPermission ? "error" : "permission")
        }
    }

    func stop() {
        running = false
        timer?.cancel()
        timer = nil
        if let stream {
            self.stream = nil
            Task { try? await stream.stopCapture() }
        }
        queue.async { [weak self] in
            self?.analyzer?.reset()
        }
    }

    /// Spotify relaunched, displays changed, …
    func restart() {
        stop()
        after(1.0) { [weak self] in self?.start() }
    }

    private func report(_ available: Bool, _ reason: String) {
        DispatchQueue.main.async { self.onStatus?(available, reason) }
    }

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(33), leeway: .milliseconds(5))
        t.setEventHandler { [weak self] in self?.emitFrame() }
        t.resume()
        timer = t
    }

    /// On `queue`.
    private func emitFrame() {
        guard let analyzer else { return }
        let now = CACurrentMediaTime()
        // No buffers for a while (Spotify paused / quiet) → stop sending so the web side can idle.
        guard now - lastSampleAt < 0.6 else { return }
        let frame = analyzer.analyze(time: now)
        DispatchQueue.main.async { [weak self] in self?.onFrame?(frame) }
    }

    // MARK: SCStreamOutput (on `queue`)

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              asbd.mBitsPerChannel == 32 else { return }

        var sizeNeeded = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard status == noErr, sizeNeeded > 0 else { return }

        let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let ablPointer = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var blockBuffer: CMBlockBuffer?
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: ablPointer, bufferListSize: sizeNeeded,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &blockBuffer)
        guard status == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(ablPointer)
        guard buffers.count > 0 else { return }

        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        if nonInterleaved {
            let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
            guard frames > 0 else { return }
            if mono.count < frames { mono = [Float](repeating: 0, count: frames) }
            let channels = min(buffers.count, 2)
            for i in 0..<frames { mono[i] = 0 }
            for c in 0..<channels {
                guard let data = buffers[c].mData?.assumingMemoryBound(to: Float.self) else { continue }
                let n = min(frames, Int(buffers[c].mDataByteSize) / MemoryLayout<Float>.size)
                for i in 0..<n { mono[i] += data[i] / Float(channels) }
            }
            feed(count: frames, sampleRate: asbd.mSampleRate)
        } else {
            let channels = max(1, Int(asbd.mChannelsPerFrame))
            guard let data = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size / channels
            guard frames > 0 else { return }
            if mono.count < frames { mono = [Float](repeating: 0, count: frames) }
            for i in 0..<frames {
                var s: Float = 0
                for c in 0..<channels { s += data[i * channels + c] }
                mono[i] = s / Float(channels)
            }
            feed(count: frames, sampleRate: asbd.mSampleRate)
        }
    }

    private func feed(count: Int, sampleRate: Double) {
        if analyzer == nil || analyzer?.sampleRate != sampleRate {
            analyzer = AudioAnalyzer(sampleRate: sampleRate > 0 ? sampleRate : 48_000)
        }
        mono.withUnsafeBufferPointer { buf in
            analyzer?.append(UnsafeBufferPointer(rebasing: buf[0..<count]))
        }
        lastSampleAt = CACurrentMediaTime()
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.audio.error("Audio stream stopped: \(error.localizedDescription, privacy: .public)")
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.running = false
            self.stream = nil
            self.timer?.cancel()
            self.timer = nil
            self.onStatus?(false, "error")
            self.restartAttempts += 1
            if self.restartAttempts <= 3 {
                after(Double(self.restartAttempts) * 4) { [weak self] in self?.start() }
            }
        }
    }
}
