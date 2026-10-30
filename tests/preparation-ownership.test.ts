import { expect, test } from "vitest";
import {
  borrowPreparedApplication,
  createPreparationRun,
} from "./support/preparation";

test("cancellation keeps its original cause when a late release cannot reach the closed run", async () => {
  const owner = await createPreparationRun();
  await owner.close();
  const cancellation = new AbortController();
  const original = new Error("original scenario cancellation");
  const borrowing = borrowPreparedApplication(
    owner.locator,
    "development",
    cancellation.signal,
  );
  cancellation.abort(original);
  const failure = await borrowing.catch((error: unknown) => error);
  expect(failure).toMatchObject({ cause: original });
});
