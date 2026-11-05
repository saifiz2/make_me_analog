import AppKit

let launchOptions = LaunchOptions(arguments: CommandLine.arguments)
let application = NSApplication.shared
let appDelegate = AppDelegate(options: launchOptions)
application.delegate = appDelegate
// The login-agent instance stays invisible (no Dock icon, not in Force Quit) unless it has to become the lock.
application.setActivationPolicy(launchOptions.resumeOnly ? .prohibited : .regular)
application.run()
