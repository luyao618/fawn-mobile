import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { RecentRecordsServicePort } from "../../../src/application/insights/recentRecordsService";
import { RecentRecordsScreen } from "../../../src/features/insights/RecentRecordsScreen";
import { RecentRecordsServiceProvider } from "../../../src/features/insights/RecentRecordsServiceContext";

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual("react");
    React.useEffect(effect, [effect]);
  },
}));

function renderScreen(service: RecentRecordsServicePort) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <RecentRecordsServiceProvider service={service}>
        <RecentRecordsScreen />
      </RecentRecordsServiceProvider>
    </SafeAreaProvider>,
  );
}

test("growth shows merged recent records", async () => {
  renderScreen({
    list: jest.fn(async () => [{
      domain: "feeding" as const,
      id: "feeding-1",
      domainLabel: "喂养",
      primary: "2026年8月3日 09:30（本机时间）",
      secondary: "配方奶 · 量 90 毫升",
      accessibilityLabel: "喂养记录，2026年8月3日 09:30（本机时间），配方奶 · 量 90 毫升",
      occurredAt: "2026-08-03T01:30:00.000Z",
    }]),
  });

  expect(await screen.findByRole("header", { name: "最近动态" })).toBeTruthy();
  expect(screen.getByText("喂养")).toBeTruthy();
  expect(screen.getByText("配方奶 · 量 90 毫升")).toBeTruthy();
  expect(screen.getByLabelText(/喂养记录/)).toBeTruthy();
});

test("growth exposes a bounded retry after a private read failure", async () => {
  const list = jest.fn()
    .mockRejectedValueOnce(new Error("private database detail"))
    .mockResolvedValueOnce([]);
  renderScreen({ list });

  const retry = await screen.findByRole("button", { name: "重新读取最近记录" });
  expect(screen.queryByText("private database detail")).toBeNull();
  await act(async () => { fireEvent.press(retry); });
  await waitFor(() => expect(screen.getByRole("header", { name: "还没有照护记录" })).toBeTruthy());
  expect(list).toHaveBeenCalledTimes(2);
});
