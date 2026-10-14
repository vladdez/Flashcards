import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(cleanup);
if (
  typeof HTMLDialogElement !== "undefined" &&
  !HTMLDialogElement.prototype.showModal
)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
if (
  typeof HTMLDialogElement !== "undefined" &&
  !HTMLDialogElement.prototype.close
)
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
