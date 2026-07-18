import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

const CLOCK_CHECK_INTERVAL_MS = 60_000;

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

function millisecondsUntilNextCheck(now: Date): number {
  return Math.min(CLOCK_CHECK_INTERVAL_MS, millisecondsUntilNextLocalDay(now));
}

export function useActiveLocalDayRefresh(onRefresh: () => void | Promise<void>): () => void {
  const requestRefreshRef = useRef<() => void>(() => undefined);

  useFocusEffect(useCallback(() => {
    let disposed = false;
    let appState: AppStateStatus | null = AppState.currentState;
    let calendarKey = localCalendarKey(new Date());
    let refreshInFlight = false;
    let retryPending = false;
    let rerunAfterFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    function finishRefresh(succeeded: boolean) {
      if (disposed) return;
      refreshInFlight = false;
      if (!succeeded) retryPending = true;
      if (rerunAfterFlight) {
        rerunAfterFlight = false;
        runRefresh();
      }
    }

    function runRefresh() {
      if (disposed) return;
      if (appState !== null && appState !== "active") {
        retryPending = true;
        return;
      }
      if (refreshInFlight) {
        rerunAfterFlight = true;
        return;
      }
      refreshInFlight = true;
      retryPending = false;
      let refreshResult: void | Promise<void>;
      try {
        refreshResult = onRefresh();
      } catch {
        finishRefresh(false);
        return;
      }
      void Promise.resolve(refreshResult).then(
        () => finishRefresh(true),
        () => finishRefresh(false),
      );
    }

    requestRefreshRef.current = runRefresh;

    const checkCalendar = () => {
      const nextCalendarKey = localCalendarKey(new Date());
      const calendarChanged = nextCalendarKey !== calendarKey;
      if (calendarChanged) calendarKey = nextCalendarKey;
      if (calendarChanged || retryPending) runRefresh();
    };

    const scheduleNextCheck = () => {
      clearTimer();
      if (disposed || (appState !== null && appState !== "active")) return;
      const now = new Date();
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        checkCalendar();
        scheduleNextCheck();
      }, millisecondsUntilNextCheck(now));
    };

    scheduleNextCheck();
    const subscription = AppState.addEventListener("change", (nextState) => {
      appState = nextState;
      if (nextState !== "active") {
        clearTimer();
        return;
      }
      checkCalendar();
      scheduleNextCheck();
    });

    return () => {
      disposed = true;
      if (requestRefreshRef.current === runRefresh) requestRefreshRef.current = () => undefined;
      clearTimer();
      subscription.remove();
    };
  }, [onRefresh]));

  return useCallback(() => requestRefreshRef.current(), []);
}
