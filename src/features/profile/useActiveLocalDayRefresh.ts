import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";

function localCalendarKey(now: Date): string {
  let timeZone = "unknown";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
  } catch {
    // The offset still detects local-calendar changes when an IANA zone is unavailable.
  }
  const localDate = [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `${timeZone}|${now.getTimezoneOffset()}|${localDate}`;
}

function millisecondsUntilNextLocalDay(now: Date): number {
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, nextDay.getTime() - now.getTime());
}

export function useActiveLocalDayRefresh(onRefresh: () => void): void {
  useFocusEffect(useCallback(() => {
    let disposed = false;
    let appState: AppStateStatus | null = AppState.currentState;
    let calendarKey = localCalendarKey(new Date());
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const scheduleNextLocalDay = () => {
      clearTimer();
      if (disposed || (appState !== null && appState !== "active")) return;
      const now = new Date();
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        const nextCalendarKey = localCalendarKey(new Date());
        if (nextCalendarKey !== calendarKey) {
          calendarKey = nextCalendarKey;
          onRefresh();
        }
        scheduleNextLocalDay();
      }, millisecondsUntilNextLocalDay(now));
    };

    scheduleNextLocalDay();
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appState;
      appState = nextState;
      if (nextState !== "active") {
        clearTimer();
        return;
      }
      calendarKey = localCalendarKey(new Date());
      if (previousState !== "active") onRefresh();
      scheduleNextLocalDay();
    });

    return () => {
      disposed = true;
      clearTimer();
      subscription.remove();
    };
  }, [onRefresh]));
}
