import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct DisplayRecord: Codable {
    let index: Int
    let id: UInt32
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let pixelWidth: Int
    let pixelHeight: Int
    let scale: Double
    let main: Bool
}

struct PermissionRecord: Codable {
    let screenCapture: Bool
    let accessibility: Bool
}

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
        let data = try encoder.encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        fail("Unable to encode JSON: \(error)")
    }
}

func doubleArg(_ index: Int, _ name: String) -> Double {
    guard CommandLine.arguments.count > index,
          let value = Double(CommandLine.arguments[index]),
          value.isFinite else {
        fail("Missing or invalid \(name).")
    }
    return value
}

func intArg(_ index: Int, _ name: String) -> Int {
    guard CommandLine.arguments.count > index,
          let value = Int(CommandLine.arguments[index]) else {
        fail("Missing or invalid \(name).")
    }
    return value
}

func mouseButton(_ raw: String) -> CGMouseButton {
    switch raw {
    case "left": return .left
    case "right": return .right
    case "center": return .center
    default: fail("Unsupported mouse button: \(raw)")
    }
}

func mouseEventTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    }
}

func modifierFlags(_ raw: String) -> CGEventFlags {
    var flags: CGEventFlags = []
    for value in raw.split(separator: ",").map(String.init) {
        switch value {
        case "": continue
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "function": flags.insert(.maskSecondaryFn)
        default: fail("Unsupported modifier: \(value)")
        }
    }
    return flags
}

func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("Unable to create mouse event.")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

func activeDisplays() -> [DisplayRecord] {
    var count: UInt32 = 0
    let first = CGGetActiveDisplayList(0, nil, &count)
    guard first == .success else { fail("Unable to enumerate displays.") }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    let second = CGGetActiveDisplayList(count, &ids, &count)
    guard second == .success else { fail("Unable to enumerate displays.") }
    ids = Array(ids.prefix(Int(count)))
    let main = CGMainDisplayID()
    ids.sort { lhs, rhs in
        if lhs == main { return true }
        if rhs == main { return false }
        let left = CGDisplayBounds(lhs)
        let right = CGDisplayBounds(rhs)
        if left.origin.y != right.origin.y { return left.origin.y < right.origin.y }
        return left.origin.x < right.origin.x
    }
    return ids.enumerated().map { offset, id in
        let bounds = CGDisplayBounds(id)
        let pixelWidth = CGDisplayPixelsWide(id)
        let pixelHeight = CGDisplayPixelsHigh(id)
        return DisplayRecord(
            index: offset + 1,
            id: id,
            x: bounds.origin.x,
            y: bounds.origin.y,
            width: bounds.width,
            height: bounds.height,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            scale: bounds.width > 0 ? Double(pixelWidth) / bounds.width : 1,
            main: id == main
        )
    }
}

func accessibilityTrusted(prompt: Bool) -> Bool {
    if prompt {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
    return AXIsProcessTrusted()
}

func typeUnicode(_ text: String) {
    let units = Array(text.utf16)
    let chunkSize = 20
    var offset = 0
    while offset < units.count {
        var end = min(offset + chunkSize, units.count)
        if end < units.count,
           units[end - 1] >= 0xD800,
           units[end - 1] <= 0xDBFF,
           units[end] >= 0xDC00,
           units[end] <= 0xDFFF {
            end -= 1
        }
        var chunk = Array(units[offset..<end])
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            fail("Unable to create keyboard event.")
        }
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(8_000)
        offset += chunk.count
    }
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

switch command {
case "permissions":
    printJSON(PermissionRecord(
        screenCapture: CGPreflightScreenCaptureAccess(),
        accessibility: accessibilityTrusted(prompt: false)
    ))

case "request-permissions":
    _ = CGRequestScreenCaptureAccess()
    _ = accessibilityTrusted(prompt: true)
    printJSON(PermissionRecord(
        screenCapture: CGPreflightScreenCaptureAccess(),
        accessibility: accessibilityTrusted(prompt: false)
    ))

case "displays":
    printJSON(activeDisplays())

case "position":
    guard let event = CGEvent(source: nil) else { fail("Unable to read cursor position.") }
    let point = event.location
    printJSON(["x": point.x, "y": point.y])

case "move":
    let point = CGPoint(x: doubleArg(2, "x"), y: doubleArg(3, "y"))
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
        fail("Unable to create mouse event.")
    }
    event.post(tap: .cghidEventTap)

case "click":
    let point = CGPoint(x: doubleArg(2, "x"), y: doubleArg(3, "y"))
    let button = mouseButton(args.count > 4 ? args[4] : "left")
    let count = max(1, min(3, intArg(5, "count")))
    let types = mouseEventTypes(button)
    for index in 1...count {
        postMouse(types.0, point: point, button: button, clickState: Int64(index))
        usleep(25_000)
        postMouse(types.1, point: point, button: button, clickState: Int64(index))
        if index < count { usleep(90_000) }
    }

case "drag":
    let start = CGPoint(x: doubleArg(2, "start x"), y: doubleArg(3, "start y"))
    let end = CGPoint(x: doubleArg(4, "end x"), y: doubleArg(5, "end y"))
    let durationMs = max(50, min(10_000, intArg(6, "duration")))
    let button = mouseButton(args.count > 7 ? args[7] : "left")
    let types = mouseEventTypes(button)
    postMouse(types.0, point: start, button: button)
    let steps = max(2, min(120, durationMs / 16))
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress
        )
        postMouse(types.2, point: point, button: button)
        usleep(useconds_t(durationMs * 1_000 / steps))
    }
    postMouse(types.1, point: end, button: button)

case "scroll":
    let deltaX = Int32(max(-100_000, min(100_000, intArg(2, "delta x"))))
    let deltaY = Int32(max(-100_000, min(100_000, intArg(3, "delta y"))))
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: deltaY,
        wheel2: deltaX,
        wheel3: 0
    ) else {
        fail("Unable to create scroll event.")
    }
    event.post(tap: .cghidEventTap)

case "key":
    let code = intArg(2, "virtual key code")
    guard code >= 0 && code <= 127 else { fail("Virtual key code is outside the supported range.") }
    let flags = modifierFlags(args.count > 3 ? args[3] : "")
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false) else {
        fail("Unable to create keyboard event.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)

case "type":
    guard args.count > 2,
          let data = Data(base64Encoded: args[2]),
          let text = String(data: data, encoding: .utf8) else {
        fail("Text payload is not valid base64 UTF-8.")
    }
    typeUnicode(text)

case "activate":
    guard args.count > 2 else { fail("Missing application name or bundle identifier.") }
    let requested = args[2]
    let applications = NSWorkspace.shared.runningApplications
    if let application = applications.first(where: {
        $0.bundleIdentifier?.caseInsensitiveCompare(requested) == .orderedSame
            || $0.localizedName?.caseInsensitiveCompare(requested) == .orderedSame
    }) {
        if !application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
            fail("Unable to activate application: \(requested)")
        }
    } else if !NSWorkspace.shared.launchApplication(requested) {
        fail("Unable to launch application: \(requested)")
    }

default:
    fail("Unsupported command: \(command)")
}
