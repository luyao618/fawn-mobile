import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { LoadedModelSettings, ModelSettingsServicePort } from "../../../src/application/settings/modelSettingsService";
import { ModelSettingsPanel } from "../../../src/features/settings/model/ModelSettingsPanel";
import { ModelSettingsServiceProvider } from "../../../src/features/settings/model/ModelSettingsServiceContext";

const loaded: LoadedModelSettings = {
  config: {
    displayName: "默认模型", baseUrl: "https://provider.example/v1", chatPath: "chat/completions",
    modelId: "alpha-model", authMode: "bearer", headerNames: [],
  },
  secrets: { revision: 1, bearerToken: "stored-secret", headers: {} },
  updatedAt: "2026-08-05T00:00:00.000Z",
  cleanupPendingRevisions: [],
};

function renderPanel(service: ModelSettingsServicePort) {
  return render(
    <ModelSettingsServiceProvider service={service}>
      <ModelSettingsPanel />
    </ModelSettingsServiceProvider>,
  );
}

test("model settings save a bearer configuration without displaying the stored key", async () => {
  const save = jest.fn(async () => loaded);
  renderPanel({ load: async () => null, save, clear: jest.fn() });
  await screen.findByLabelText("Base URL");
  fireEvent.changeText(screen.getByLabelText("Base URL"), "https://provider.example/v1");
  fireEvent.changeText(screen.getByLabelText("模型 ID"), "alpha-model");
  fireEvent.changeText(screen.getByLabelText("API Key"), "stored-secret");
  expect(screen.getByLabelText("API Key").props.secureTextEntry).toBe(true);
  expect(screen.queryByText("stored-secret")).toBeNull();
  await act(async () => { fireEvent.press(screen.getByRole("button", { name: "保存模型设置" })); });
  await waitFor(() => expect(screen.getByText("模型设置已保存在本机")).toBeTruthy());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    baseUrl: "https://provider.example/v1",
    modelId: "alpha-model",
    authMode: "bearer",
  }), { bearerToken: "stored-secret" }, expect.any(String));
  expect(screen.getByLabelText("API Key").props.value).toBe("");
});

test("model settings require an explicit second press before clearing", async () => {
  const clear = jest.fn(async () => ({ deletedRevisions: [1], failedRevisions: [], pendingRevisions: [] }));
  renderPanel({ load: async () => loaded, save: jest.fn(), clear });
  const first = await screen.findByRole("button", { name: "清除设置" });
  fireEvent.press(first);
  expect(clear).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByRole("button", { name: "确认清除" })); });
  await waitFor(() => expect(screen.getByText("模型设置已清除")).toBeTruthy());
  expect(clear).toHaveBeenCalledTimes(1);
});
