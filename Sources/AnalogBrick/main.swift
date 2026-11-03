import AppKit

let launchOptions = LaunchOptions(arguments: CommandLine.arguments)
let application = NSApplication.shared
let appDelegate = AppDelegate(options: launchOptions)
application.delegate = appDelegate
application.setActivationPolicy(.regular)
application.run()
