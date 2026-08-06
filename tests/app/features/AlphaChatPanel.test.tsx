import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { AlphaChatServicePort } from "../../../src/application/chat/alphaChatService";
import type { LoadedModelSettings, ModelSettingsServicePort } from "../../../src/application/settings/modelSettingsService";
import { AlphaChatPanel } from "../../../src/features/chat/AlphaChatPanel";
import { ChatServiceProvider } from "../../../src/features/chat/ChatServiceContext";
import { ModelSettingsServiceProvider } from "../../../src/features/settings/model/ModelSettingsServiceContext";

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = jest.requireActual("react");
    React.useEffect(effect, [effect]);
  },
}));

const loaded: LoadedModelSettings = {
  config: {
    displayName: "默认模型", baseUrl: "https://provider.example/v1", chatPath: "chat/completions",
    modelId: "alpha-model", authMode: "bearer", headerNames: [],
  },
  secrets: { revision: 1, bearerToken: "stored-secret", headers: {} },
  updatedAt: "2026-08-05T00:00:00.000Z",
  cleanupPendingRevisions: [],
};

function renderPanel(modelSettings: ModelSettingsServicePort, chat: AlphaChatServicePort) {
  return render(
    <ModelSettingsServiceProvider service={modelSettings}>
      <ChatServiceProvider service={chat}>
        <AlphaChatPanel />
      </ChatServiceProvider>
    </ModelSettingsServiceProvider>,
  );
}

test("chat stays unavailable until a model is configured", async () => {
  renderPanel({ load: async () => null, save: jest.fn(), clear: jest.fn() }, { send: jest.fn() });
  expect(await screen.findByText("请先在“我的”中配置模型连接。")).toBeTruthy();
  expect(screen.queryByLabelText("给管家的问题")).toBeNull();
});

test("chat sends one question and renders the answer", async () => {
  const send = jest.fn(async () => ({ content: "今天可以继续记录喂养量。", modelId: "alpha-model", contextRecordCount: 3 }));
  renderPanel({ load: async () => loaded, save: jest.fn(), clear: jest.fn() }, { send });
  const input = await screen.findByLabelText("给管家的问题");
  fireEvent.changeText(input, "结合最近记录，我需要留意什么？");
  await act(async () => { fireEvent.press(screen.getByRole("button", { name: "发送" })); });
  await waitFor(() => expect(screen.getByText("今天可以继续记录喂养量。")).toBeTruthy());
  expect(screen.getByText("结合最近记录，我需要留意什么？")).toBeTruthy();
  expect(send).toHaveBeenCalledWith("结合最近记录，我需要留意什么？");
});
