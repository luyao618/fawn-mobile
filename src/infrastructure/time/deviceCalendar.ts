import type {
  DeviceCalendarPort,
  DeviceCalendarSnapshot,
} from "../../application/profile/babyProfileService.ts";
import { localDateAtInstant } from "../../domain/baby/localDate.ts";

export class IntlDeviceCalendar implements DeviceCalendarPort {
  current(): DeviceCalendarSnapshot {
    const instant = new Date().toISOString();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    localDateAtInstant(instant, timeZone);
    return Object.freeze({ instant, timeZone });
  }
}
