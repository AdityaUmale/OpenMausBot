import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

const CREATE = "/api/bots/bot/tasks";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { initialState.bots = []; vi.unstubAllGlobals(); });

it("makes one conversation for a double or triple click on New conversation", async () => {
  let answer!: () => void;
  const requests = vi.fn<typeof fetch>(async (path) => {
    if (path !== CREATE) return new Response("{}");
    await new Promise<void>((resolve) => { answer = resolve; });
    return new Response(JSON.stringify({ bot: { id: "bot", threadId: "new" } }), { status: 201 });
  });
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  for (let click = 0; click < 3; click++) dispatch({ type: "newTask", botId: "bot" });
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === CREATE)).toHaveLength(1);
  answer();
  await flush();
  dispatch({ type: "newTask", botId: "bot" });
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === CREATE)).toHaveLength(2);
});
