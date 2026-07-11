import { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";

import { evaluateVariant } from "./mobileBenchmark";
import { thresholdFailures } from "./scoring";

const prefix = "G015_ANDROID_PROOF ";

export default function App() {
  const [output, setOutput] = useState(prefix + JSON.stringify({ schemaVersion: 1, platform: "android", status: "RUNNING", reports: [] }));

  useEffect(() => {
    void (async () => {
      const reports = [];
      try {
        reports.push(await evaluateVariant("public"), await evaluateVariant("private"));
        const failures = reports.flatMap((report) => thresholdFailures(report).map((metric) => `${report.variant}:${metric}`));
        const status = failures.length ? "FAIL" : "PASS";
        const line = prefix + JSON.stringify({ schemaVersion: 1, platform: "android", status, reports, failures });
        status === "PASS" ? console.log(line) : console.error(line);
        setOutput(line);
      } catch (error) {
        const line = prefix + JSON.stringify({ schemaVersion: 1, platform: "android", status: "FAIL", reports, error: String(error) });
        console.error(line);
        setOutput(line);
      }
    })();
  }, []);

  return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.content}>
    <Text selectable style={styles.title}>G015 SQLite FTS5</Text>
    <Text selectable style={styles.output}>{output}</Text>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f6f4ed" },
  content: { padding: 24, gap: 16 },
  title: { color: "#18332f", fontSize: 24, fontWeight: "700" },
  output: { color: "#18332f", fontFamily: "monospace", fontSize: 12 },
});
