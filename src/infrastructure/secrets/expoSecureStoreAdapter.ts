import * as SecureStore from "expo-secure-store";

import type { SecureKeyValueStore } from "./revisionedSecureStore.ts";

export const expoSecureStoreAdapter: SecureKeyValueStore = Object.freeze({
  getItemAsync(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  },
  setItemAsync(key: string, value: string): Promise<void> {
    return SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  deleteItemAsync(key: string): Promise<void> {
    return SecureStore.deleteItemAsync(key);
  },
});
