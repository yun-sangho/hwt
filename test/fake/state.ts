// State shared by the fake herdr-app and hc, in the JSON file $HWT_FAKE_STATE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface FakeTerminal {
  address: string;
  name: string | null;
  agent: string | null;
  status: string;
  state: string;
  cwd: string;
  labels: Record<string, string>;
  parent: string | null;
  created_ms: number;
  argv?: string[];
}

export interface FakeState {
  seq: number;
  spaces: { id: string; name: string | null; folder: string; tabs: { id: string; name: string | null }[] }[];
  terminals: FakeTerminal[];
  sent: { to: string; text: string }[];
  calls: { cmd: string; arg: Record<string, unknown> }[];
  prs?: Record<string, FakePr>;
}

export interface FakePr {
  head: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: "pass" | "fail" | "pending" | "none";
  mergeQueue?: "required" | "queued";
  autoMerge?: boolean;
  mergeAfterPolls?: number;
  queueReadError?: boolean;
  sha?: string;
}

const file = () => process.env.HWT_FAKE_STATE ?? "/tmp/hwt-fake-state.json";

export function load(): FakeState {
  if (!existsSync(file())) return { seq: 100, spaces: [], terminals: [], sent: [], calls: [] };
  return JSON.parse(readFileSync(file(), "utf8"));
}

export function save(s: FakeState): void {
  writeFileSync(file(), JSON.stringify(s, null, 2));
}

export const basename = (p: string) => p.split("/").pop() ?? p;
