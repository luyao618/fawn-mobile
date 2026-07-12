import { useEffect, useRef, useState } from "react";
import { Platform, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { DeviceProofError, G017_PROOF_CONTRACT, G017_PROOF_PREFIX, runDeviceProof } from "./src/deviceProof.ts";

type State =
  | { status: "running" }
  | { status: "passed"; report: unknown }
  | { status: "failed"; error: string };

export default function App() {
  const [state, setState] = useState<State>({ status: "running" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    runDeviceProof()
      .then((report) => {
        console.log(`${G017_PROOF_PREFIX}${JSON.stringify(report)}`);
        setState({ status: "passed", report });
      })
      .catch((error: unknown) => {
        const message = error instanceof DeviceProofError ? error.code : "UNEXPECTED_PROOF_FAILURE";
        console.error(`${G017_PROOF_PREFIX}${JSON.stringify({ schemaVersion: 1, contractId: G017_PROOF_CONTRACT, status: "FAIL", code: message })}`);
        setState({ status: "failed", error: message });
      });
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>G017 Model Transport Proof</Text>
        <View style={styles.status}>
          <Text testID="slice0-status" style={styles.statusText}>{state.status.toUpperCase()}</Text>
        </View>
        {state.status === "passed" ? (
          <Text selectable style={styles.output}>{JSON.stringify(state.report, null, 2)}</Text>
        ) : null}
        {state.status === "failed" ? <Text selectable style={styles.error}>{state.error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f6f7" },
  content: { padding: 20, gap: 12 },
  title: { color: "#17212b", fontSize: 24, fontWeight: "700" },
  status: { alignSelf: "flex-start", backgroundColor: "#dfe8df", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  statusText: { color: "#173d24", fontSize: 14, fontWeight: "700" },
  output: {
    color: "#24313d",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
  error: { color: "#8b1e1e", fontSize: 14, lineHeight: 20 },
});
