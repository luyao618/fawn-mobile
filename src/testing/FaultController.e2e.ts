import { Linking } from "react-native";

import { parseFaultUrl, type FaultRequest } from "./faultContract";

const noOp = () => {};

export async function installE2EFaultController(
  onFault: (request: FaultRequest) => void,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) return noOp;
  let active = true;
  let removed = false;
  const handleUrl = ({ url }: { url: string }) => {
    if (!active || signal?.aborted) return;
    const request = parseFaultUrl(url);
    if (request) onFault(request);
  };
  const subscription = Linking.addEventListener("url", handleUrl);
  const dispose = () => {
    if (removed) return;
    active = false;
    removed = true;
    signal?.removeEventListener("abort", dispose);
    subscription.remove();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    const url = await Linking.getInitialURL();
    if (url) handleUrl({ url });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
