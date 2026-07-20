import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";

import type { AppRuntime, ReadyAppServices } from "../../../src/application/bootstrap/appRuntime";
import type { ManualTrackerServicePort } from "../../../src/application/tracker/manualTrackerService";
import {
  ManualTrackerServiceProvider,
  useManualTrackerService,
} from "../../../src/features/tracker/ManualTrackerServiceContext";
import type { ProductionBootstrap } from "../../../src/infrastructure/bootstrap/createProductionBootstrap";
import { getTabBarMetrics, RootNavigator } from "../../../src/navigation/RootNavigator";

jest.mock("@react-native-vector-icons/lucide/static", () => ({
  Lucide: () => null,
}));

function trackerService(list = jest.fn(async () => [])): ManualTrackerServicePort {
  return {
    getById: jest.fn(async () => null),
    list,
    create: jest.fn(async () => { throw new Error("not used"); }),
    update: jest.fn(async () => { throw new Error("not used"); }),
    delete: jest.fn(async () => { throw new Error("not used"); }),
  } as ManualTrackerServicePort;
}

function readyRuntime(load = jest.fn(async () => ({
  profile: null,
  exactAge: { status: "unknown" as const, reason: "birth_date_missing" as const, localDate: "2026-07-18", timeZone: "Asia/Shanghai" },
})), tracker = trackerService()): AppRuntime<ReadyAppServices> {
  return {
    services: {
      babyProfile: {
        load,
        async save() { throw new Error("not used"); },
      },
      tracker,
    },
    async close() {},
  };
}

async function renderNavigator(bootstrap: ProductionBootstrap<ReadyAppServices> = async () => readyRuntime()) {
  const view = render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <RootNavigator bootstrap={bootstrap} />
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByRole("header", { name: "照护空间尚未设置" })).toBeTruthy());
  return view;
}

test("renders exactly five accessible tabs with 管家 selected initially", async () => {
  await renderNavigator();
  expect(screen.getByRole("header", { name: "照护空间尚未设置" })).toBeTruthy();
  const labels = ["管家", "记录", "成长", "相册", "我的"];
  const tabs = screen.getAllByRole("button").filter((item) => labels.includes(item.props.accessibilityLabel));
  expect(tabs).toHaveLength(5);
  expect(tabs.map((item) => item.props.accessibilityLabel)).toEqual(labels);
  const routeIds = [
    "StewardTab",
    "RecordsTab",
    "GrowthTab",
    "AlbumTab",
    "MeTab",
  ].map((route) => `tab-${route}`);
  expect(screen.getAllByTestId(/^tab-/).map((item) => item.props.testID)).toEqual(routeIds);
  for (const tab of tabs) expect(StyleSheet.flatten(tab.props.style)).toMatchObject({ flex: 1 });
  expect(screen.getByLabelText("管家").props.accessibilityState).toMatchObject({ selected: true });
});

test.each([
  ["记录", "生长记录"],
  ["成长", "还没有可展示的成长数据"],
  ["相册", "还没有照片"],
  ["我的", "宝宝资料"],
])("visits %s through its accessible tab", async (label, heading) => {
  await renderNavigator();
  fireEvent.press(screen.getByLabelText(label));
  expect(await screen.findByRole("header", { name: heading })).toBeTruthy();
});

function TrackerServiceProbe({ expected }: { expected: ManualTrackerServicePort }) {
  const service = useManualTrackerService();
  return <Text>{service === expected ? "tracker-service-ready" : "wrong-service"}</Text>;
}

test("tracker service context returns the supplied ready service and rejects missing readiness scope", () => {
  const tracker = trackerService();
  render(
    <ManualTrackerServiceProvider service={tracker}>
      <TrackerServiceProbe expected={tracker} />
    </ManualTrackerServiceProvider>,
  );
  expect(screen.getByText("tracker-service-ready")).toBeTruthy();

  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<TrackerServiceProbe expected={tracker} />)).toThrow(
    "Manual tracker service is unavailable before application readiness",
  );
  consoleError.mockRestore();
});

test("Records starts the growth list read without waiting for a baby profile snapshot", async () => {
  const profileLoad = jest.fn(() => new Promise<never>(() => undefined));
  const list = jest.fn(async () => []);
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <RootNavigator bootstrap={async () => readyRuntime(profileLoad, trackerService(list))} />
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("记录")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("记录"));
  expect(await screen.findByRole("header", { name: "生长记录" })).toBeTruthy();
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  expect(list).toHaveBeenCalledWith("growth", 100);
  expect(profileLoad).toHaveBeenCalledTimes(1);
});


test("tab metrics preserve default geometry and grow for 200% text above the safe-area inset", () => {
  expect(getTabBarMetrics(1, 0)).toEqual({ height: 64, itemPaddingVertical: 0 });
  expect(getTabBarMetrics(1, 34)).toEqual({ height: 83, itemPaddingVertical: 0 });
  expect(getTabBarMetrics(2, 24)).toEqual({ height: 93, itemPaddingVertical: 4 });
  expect(getTabBarMetrics(2, 34)).toEqual({ height: 103, itemPaddingVertical: 4 });
});

test("does not call profile services or expose navigation before recovered runtime readiness", async () => {
  let resolve!: (runtime: AppRuntime<ReadyAppServices>) => void;
  const pending = new Promise<AppRuntime<ReadyAppServices>>((done) => { resolve = done; });
  const load = jest.fn(async () => ({
    profile: null,
    exactAge: { status: "unknown" as const, reason: "birth_date_missing" as const, localDate: "2026-07-18", timeZone: "Asia/Shanghai" },
  }));
  render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <RootNavigator bootstrap={() => pending} />
    </SafeAreaProvider>,
  );
  expect(screen.getByLabelText("正在准备本机数据")).toBeTruthy();
  expect(screen.queryByLabelText("管家")).toBeNull();
  expect(load).not.toHaveBeenCalled();

  await act(async () => resolve(readyRuntime(load)));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("管家")).toBeTruthy();
});

test("管家 reloads exact age when it regains focus after profile editing", async () => {
  const missing = {
    profile: null,
    exactAge: { status: "unknown" as const, reason: "birth_date_missing" as const, localDate: "2025-02-28", timeZone: "America/Los_Angeles" },
  };
  const known = {
    profile: {
      name: "测试宝宝", sex: "female" as const, birthDate: "2024-02-29", birthWeightG: null,
      birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
      createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
    },
    exactAge: {
      status: "known" as const, localDate: "2025-02-28", timeZone: "America/Los_Angeles",
      ageDays: 365, completedMonths: 12, remainingDays: 0,
    },
  };
  const load = jest.fn()
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(known);
  await renderNavigator(async () => readyRuntime(load));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByLabelText("我的"));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  fireEvent.press(screen.getByLabelText("管家"));
  expect(await screen.findByText("12个月0天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(3);
});
