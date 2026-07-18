import Foundation

@main
struct IOSDeviceCalendar {
  static func main() {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    print("\(formatter.string(from: Date()))\t\(TimeZone.current.identifier)")
  }
}
