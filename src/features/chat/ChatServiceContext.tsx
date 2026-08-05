import { createContext, type PropsWithChildren, useContext } from "react";

import type { AlphaChatServicePort } from "../../application/chat/alphaChatService";

const ChatServiceContext = createContext<AlphaChatServicePort | null>(null);

export function ChatServiceProvider({ children, service }: PropsWithChildren<{ service: AlphaChatServicePort }>) {
  return <ChatServiceContext.Provider value={service}>{children}</ChatServiceContext.Provider>;
}

export function useOptionalChatService(): AlphaChatServicePort | null {
  return useContext(ChatServiceContext);
}
