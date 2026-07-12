import { useEffect, useState } from "react";
import { Platform, SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";

import { runAndLogMobileProof } from "./mobileProof.ts";

type State =
  | Readonly<{ status: "RUNNING" }>
  | Readonly<{ status: "IN_PROCESS_PASS"; report: unknown }>
  | Readonly<{ status: "FAIL"; error: string }>;

export default function App() {
  const [state, setState] = useState<State>({ status: "RUNNING" });

  useEffect(() => {
    void runAndLogMobileProof().then(
      (report) => setState({ status: "IN_PROCESS_PASS", report }),
      (error: unknown) => setState({ status: "FAIL", error: error instanceof Error ? error.message : String(error) }),
    );
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>G016 FMBK Crypto Proof</Text>
        <Text testID="g016-status" style={state.status === "FAIL" ? styles.failure : styles.status}>
          {state.status}
        </Text>
        {state.status === "IN_PROCESS_PASS" ? <Text selectable style={styles.output}>{JSON.stringify(state.report, null, 2)}</Text> : null}
        {state.status === "FAIL" ? <Text selectable style={styles.failure}>{state.error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f5f1e8" },
  content: { gap: 14, padding: 24 },
  title: { color: "#18332f", fontSize: 24, fontWeight: "700" },
  status: { color: "#17643b", fontSize: 16, fontWeight: "700" },
  failure: { color: "#9c2727", fontSize: 14, fontWeight: "700" },
  output: {
    color: "#253933",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 11,
    lineHeight: 16,
  },
});
