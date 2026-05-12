import { afterAll, beforeAll } from "bun:test";
import { ServerRuntimeTest } from "./effect";

beforeAll(async () => {
  await ServerRuntimeTest.runtime();
});

afterAll(async () => {
  await ServerRuntimeTest.dispose();
});
