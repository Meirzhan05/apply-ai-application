import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import type { Browser, Page } from "playwright-core";

type SubmittedForm = { document: Document; data: FormData };
type InputFile = { name: string; mimeType: string; buffer: Buffer };
type StoredRoute = (route: {
  request(): { isNavigationRequest(): boolean; frame(): { parentFrame(): null }; url(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}) => Promise<void>;
type FileObservation = { name: string; mimeType: string; size: number; sha256: string; bytes: Buffer };

interface FixtureOptions {
  targetUrl: string;
  html: string;
  onSubmit?: (submission: SubmittedForm) => void;
}

const rect = (width = 240, height = 24) => ({
  x: 12, y: 12, top: 12, right: width + 12, bottom: height + 12, left: 12, width, height,
  toJSON: () => ({ x: 12, y: 12, width, height, top: 12, right: width + 12, bottom: height + 12, left: 12 }),
});

function installDomGlobals(window: JSDOM["window"]) {
  const values: Record<string, unknown> = {
    window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement, HTMLButtonElement: window.HTMLButtonElement,
    NodeFilter: window.NodeFilter, FormData: window.FormData, File: window.File,
    getComputedStyle: window.getComputedStyle.bind(window), innerHeight: window.innerHeight,
    crypto: window.crypto,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (character) => "\\" + character) },
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

async function inDom<T>(window: JSDOM["window"], work: () => T | Promise<T>): Promise<T> {
  const restore = installDomGlobals(window);
  try { return await work(); }
  finally { restore(); }
}

function installDomCapabilities(window: JSDOM["window"]) {
  Object.defineProperty(window.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
  // Chromium's computed style resolves the CSS initial value of visibility to
  // "visible" and opacity to "1". jsdom returns empty strings for these
  // initial values unless they are declared explicitly.
  window.document.documentElement.style.visibility = "visible";
  window.document.body.style.visibility = "visible";
  const browserDefaults = window.document.createElement("style");
  browserDefaults.textContent = "html, body, body * { visibility: visible; opacity: 1; }";
  window.document.head.appendChild(browserDefaults);
  if (!(window.File.prototype as File & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer) {
    Object.defineProperty(window.File.prototype, "arrayBuffer", {
      configurable: true,
      value(this: File) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new window.FileReader();
          reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("The fixture File could not be read as bytes."));
          reader.onerror = () => reject(reader.error ?? new Error("The fixture File could not be read."));
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
  Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const hidden = this.closest("[hidden]") || (this instanceof window.HTMLElement &&
        (window.getComputedStyle(this).display === "none" || window.getComputedStyle(this).visibility === "hidden"));
      return rect(hidden ? 0 : undefined, hidden ? 0 : undefined);
    },
  });
  Object.defineProperty(window.Element.prototype, "getClientRects", {
    configurable: true,
    value(this: Element) {
      const box = this.getBoundingClientRect();
      return box.width > 0 && box.height > 0 ? [box] : [];
    },
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
}

class ControlledLocator {
  constructor(private readonly page: ControlledPage, private readonly selector: string, private readonly selected?: Element[]) {}

  private elements(): Element[] {
    if (this.selected) return this.selected.filter((element) => element.isConnected);
    if (this.selector.startsWith("xpath=ancestor::fieldset")) {
      const parent = this.page.currentElement();
      const fieldset = parent?.closest("fieldset");
      return fieldset ? [fieldset] : [];
    }
    if (this.selector.startsWith("role:")) return this.page.roleElements(this.selector.slice(5));
    return Array.from(this.page.document.querySelectorAll(this.selector));
  }

  first() { return new ControlledLocator(this.page, this.selector, this.elements().slice(0, 1)); }
  nth(index: number) { return new ControlledLocator(this.page, this.selector, this.elements().slice(index, index + 1)); }
  locator(selector: string) { return new ControlledLocator(this.page, selector, this.elements().flatMap((element) => Array.from(element.querySelectorAll(selector)))); }
  getByRole(role: string, options?: { name?: string | RegExp }) {
    const candidates = this.elements().flatMap((element) => Array.from(element.querySelectorAll("*")));
    const matching = candidates.filter((element) => this.page.hasRole(element, role) && this.page.matchesName(element, options?.name));
    return new ControlledLocator(this.page, "role:" + role, matching);
  }
  filter(options: { hasText?: string | RegExp }) {
    const matcher = options.hasText;
    if (!matcher) return this;
    return new ControlledLocator(this.page, this.selector, this.elements().filter((element) => {
      const text = element.textContent ?? "";
      return typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
    }));
  }
  async count() { return this.elements().length; }
  async isVisible() { return this.elements().some((element) => element.getClientRects().length > 0 && this.page.window.getComputedStyle(element).visibility !== "hidden"); }
  async isEnabled() {
    const element = this.elements()[0];
    return Boolean(element && !("disabled" in element && (element as HTMLButtonElement).disabled));
  }
  async getAttribute(name: string) { return this.elements()[0]?.getAttribute(name) ?? null; }
  async innerText() { const element = this.elements()[0]; return element ? ((element as HTMLElement).innerText || element.textContent || "") : ""; }
  async evaluate<T>(callback: (element: unknown) => T | Promise<T>) {
    const element = this.elements()[0];
    if (!element) throw new Error("The controlled DOM locator matched no element.");
    this.page.setCurrentElement(element);
    return inDom(this.page.window, () => callback(element));
  }
  async evaluateAll<T>(callback: (elements: unknown[]) => T | Promise<T>) {
    const elements = this.elements();
    this.page.setCurrentElement(elements[0]);
    return inDom(this.page.window, () => callback(elements));
  }
  async fill(value: string) {
    const element = this.elements()[0];
    if (!(element instanceof this.page.window.HTMLInputElement || element instanceof this.page.window.HTMLTextAreaElement)) throw new Error("The controlled DOM target is not editable text.");
    element.value = value;
    element.dispatchEvent(new this.page.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new this.page.window.Event("change", { bubbles: true }));
  }
  async check() {
    const element = this.elements()[0];
    if (!(element instanceof this.page.window.HTMLInputElement)) throw new Error("The controlled DOM target is not a checkbox or radio.");
    element.checked = true;
    element.dispatchEvent(new this.page.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new this.page.window.Event("change", { bubbles: true }));
  }
  async selectOption(option: string | { label?: string; value?: string }) {
    const element = this.elements()[0];
    if (!(element instanceof this.page.window.HTMLSelectElement)) throw new Error("The controlled DOM target is not a select.");
    const desired = typeof option === "string" ? option : option.value ?? option.label ?? "";
    const match = Array.from(element.options).find((candidate) => candidate.value === desired || candidate.label === desired);
    if (!match) throw new Error("The controlled DOM select option was not found.");
    element.value = match.value;
    element.dispatchEvent(new this.page.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new this.page.window.Event("change", { bubbles: true }));
    return [match.value];
  }
  async setInputFiles(file: InputFile) {
    const input = this.elements()[0];
    if (!(input instanceof this.page.window.HTMLInputElement) || input.type !== "file") throw new Error("The controlled DOM target is not a file input.");
    const domFile = new this.page.window.File([new Uint8Array(file.buffer)], file.name, { type: file.mimeType });
    // jsdom has no DataTransfer constructor; preserve a FileList-shaped object whose File bytes are still read through File.arrayBuffer().
    const fileList = Object.create(this.page.window.FileList.prototype) as FileList & { [index: number]: File; length: number; item(index: number): File | null };
    Object.defineProperties(fileList, {
      0: { configurable: true, enumerable: true, value: domFile },
      length: { configurable: true, value: 1 },
      item: { configurable: true, value: (index: number) => index === 0 ? domFile : null },
    });
    Object.defineProperty(input, "files", { configurable: true, value: fileList });
    Object.defineProperty(input, "value", { configurable: true, value: `C:\\fakepath\\${file.name}` });
    Object.defineProperty(input, "validity", { configurable: true, value: { valid: true } });
    input.dispatchEvent(new this.page.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new this.page.window.Event("change", { bubbles: true }));
  }
  async press(key: string) {
    const element = this.elements()[0];
    if (!element) throw new Error("The controlled DOM locator matched no element.");
    element.dispatchEvent(new this.page.window.KeyboardEvent("keydown", { key, bubbles: true }));
    element.dispatchEvent(new this.page.window.KeyboardEvent("keyup", { key, bubbles: true }));
  }
  async click() {
    const element = this.elements()[0];
    if (!(element instanceof this.page.window.HTMLElement)) throw new Error("The controlled DOM target is not clickable.");
    element.click();
  }
  async waitFor() { if (!this.elements().length) throw new Error("The controlled DOM locator did not appear."); }
}

class ControlledPage {
  readonly window: JSDOM["window"];
  readonly document: Document;
  private current: string;
  private currentTarget?: Element;
  private routeHandlers: StoredRoute[] = [];
  private clickCount = 0;
  private submitCount = 0;
  private blocked: string[] = [];

  constructor(private readonly options: FixtureOptions) {
    const dom = new JSDOM(options.html, { url: options.targetUrl, pretendToBeVisual: true });
    this.window = dom.window;
    this.document = dom.window.document;
    this.current = options.targetUrl;
    installDomCapabilities(this.window);
    this.bindSubmitBehavior();
  }

  private bindSubmitBehavior() {
    this.document.querySelectorAll<HTMLButtonElement>('button[type="submit"], input[type="submit"], button:not([type])').forEach((button) => {
      button.addEventListener("click", () => { this.clickCount += 1; });
    });
    this.document.querySelectorAll<HTMLFormElement>("form").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitCount += 1;
      this.options.onSubmit?.({ document: this.document, data: new this.window.FormData(form) as unknown as FormData });
    }));
  }

  currentElement() { return this.currentTarget; }
  setCurrentElement(element?: Element) { this.currentTarget = element; }
  hasRole(element: Element, role: string) {
    if (element.getAttribute("role") === role) return true;
    if (role === "button") return element.tagName === "BUTTON" || element.matches('input[type="submit"], input[type="button"]');
    if (role === "option") return element.tagName === "OPTION";
    if (role === "radio") return element.matches('input[type="radio"]');
    if (role === "checkbox") return element.matches('input[type="checkbox"]');
    if (role === "textbox") return element.matches("input:not([type]), input[type=text], input[type=email], textarea");
    return false;
  }
  matchesName(element: Element, name?: string | RegExp) {
    if (!name) return true;
    const actual = element.getAttribute("aria-label") || (element as HTMLElement).innerText || element.textContent || ("value" in element ? String((element as HTMLInputElement).value) : "");
    return typeof name === "string" ? actual.trim() === name : name.test(actual.trim());
  }
  roleElements(role: string) {
    const native = role === "button" ? 'button, input[type="button"], input[type="submit"]'
      : role === "option" ? "option" : role === "radio" ? 'input[type="radio"]' : role === "checkbox" ? 'input[type="checkbox"]'
      : role === "textbox" ? "input:not([type]), input[type=text], input[type=email], textarea" : '[role="' + role + '"]';
    return Array.from(this.document.querySelectorAll(native)).filter((element) => this.hasRole(element, role));
  }

  context() {
    return {
      pages: () => [this.page()],
      newPage: async () => this.page(),
      route: async (_pattern: string, handler: StoredRoute) => { this.routeHandlers.push(handler); },
    };
  }
  private page(): Page { return this.pageApi as unknown as Page; }
  private readonly pageApi = {
    context: () => this.context(),
    url: () => this.current,
    title: async () => this.document.title,
    goto: async (url: string) => {
      const target = new URL(url, this.current).href;
      for (const handler of this.routeHandlers) {
        let aborted = false;
        const route = {
          request: () => ({ isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }), url: () => target }),
          abort: async () => { aborted = true; },
          continue: async () => undefined,
        };
        await handler(route);
        if (aborted) { this.blocked.push(target); return; }
      }
      this.current = target;
      try { this.window.history.replaceState({}, "", target); } catch { /* Cross-origin navigations are blocked by route policy. */ }
    },
    locator: (selector: string) => new ControlledLocator(this, selector),
    getByRole: (role: string, options?: { name?: string | RegExp }) =>
      new ControlledLocator(this, "role:" + role, this.roleElements(role).filter((element) => this.matchesName(element, options?.name))),
    waitForFunction: async (callback: () => unknown, _argument?: unknown, options?: { timeout?: number }) => {
      const result = await inDom(this.window, callback);
      if (!result && options?.timeout) throw new Error("The controlled DOM condition was not met.");
      return result;
    },
    waitForTimeout: async (duration: number) => new Promise((resolve) => setTimeout(resolve, Math.min(duration, 10))),
    waitForLoadState: async () => undefined,
    screenshot: async () => Buffer.from("controlled DOM fixture screenshot"),
  };
  pageHandle() { return this.pageApi as unknown as Page; }
  browserHandle(): Browser {
    const page = this.pageApi as unknown as Page;
    const context = this.context();
    return { contexts: () => [context], newPage: async () => page, close: async () => undefined } as unknown as Browser;
  }

  async attachedFiles(): Promise<FileObservation[]> {
    const observed = await this.pageApi.locator('input[type="file"]').evaluateAll(async (elements) => Promise.all(
      elements.flatMap((element) => Array.from((element as HTMLInputElement).files ?? []).map(async (file) => {
        const bytes = new Uint8Array(await (file as File & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return { name: file.name, mimeType: file.type, size: file.size,
          sha256: Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join(""), bytes: Array.from(bytes) };
      })),
    ));
    return observed.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
  }
  observations() { return { submitClicks: this.clickCount, formSubmissions: this.submitCount, bodyText: this.document.body.textContent ?? "", currentUrl: this.current, blockedNavigations: [...this.blocked] }; }
  replaceHtml(html: string) {
    this.document.body.innerHTML = new JSDOM(html).window.document.body.innerHTML;
    this.bindSubmitBehavior();
  }
}

export function createControlledEmployerBrowser(options: FixtureOptions) {
  const controlled = new ControlledPage(options);
  return {
    browser: controlled.browserHandle(),
    page: controlled.pageHandle(),
    attachedFiles: () => controlled.attachedFiles(),
    observations: () => controlled.observations(),
    replaceHtml: (html: string) => controlled.replaceHtml(html),
  };
}
