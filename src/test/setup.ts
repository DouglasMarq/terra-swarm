import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  if (typeof document !== "undefined") cleanup();
});

if (typeof window !== "undefined") {
  // react-resizable-panels and Radix both expect these browser primitives;
  // keeping the shims here avoids coupling production code to jsdom.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
