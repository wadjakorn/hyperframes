import { parseHTML } from "linkedom";

export interface SourceMutationTarget {
  id?: string | null;
  selector?: string;
  selectorIndex?: number;
}

function parseSourceDocument(source: string): { document: Document; wrappedFragment: boolean } {
  const hasDocumentShell = /<!doctype|<html[\s>]/i.test(source);
  if (hasDocumentShell) {
    return { document: parseHTML(source).document, wrappedFragment: false };
  }
  return {
    document: parseHTML(`<!DOCTYPE html><html><head></head><body>${source}</body></html>`).document,
    wrappedFragment: true,
  };
}

function querySelectorAllWithTemplates(root: Document | Element, selector: string): Element[] {
  const matches = Array.from(root.querySelectorAll(selector));
  if (matches.length > 0) return matches;
  // querySelectorAll doesn't traverse <template> content in linkedom.
  // Search directly on each template element (NOT .content — removing from
  // .content's DocumentFragment doesn't update the serialized output).
  const templates = Array.from(root.querySelectorAll("template"));
  for (const tmpl of templates) {
    const inner = tmpl.querySelectorAll(selector);
    if (inner.length > 0) return Array.from(inner);
  }
  return [];
}

function findTargetElement(document: Document, target: SourceMutationTarget): Element | null {
  if (target.id) {
    const byId = document.getElementById(target.id);
    if (byId) return byId;
  }

  if (!target.selector) return null;
  try {
    const matches = querySelectorAllWithTemplates(document, target.selector);
    return matches[target.selectorIndex ?? 0] ?? null;
  } catch {
    return null;
  }
}

export function removeElementFromHtml(source: string, target: SourceMutationTarget): string {
  const { document, wrappedFragment } = parseSourceDocument(source);
  const element = findTargetElement(document, target);
  if (!element) return source;

  element.remove();
  return wrappedFragment ? document.body.innerHTML || "" : document.toString();
}

function isHTMLElement(el: Element): boolean {
  const HTMLEl = el.ownerDocument.defaultView?.HTMLElement;
  return HTMLEl ? el instanceof HTMLEl : "style" in el;
}

export interface PatchOperation {
  type: "inline-style" | "attribute" | "html-attribute" | "text-content";
  property: string;
  value: string | null;
}

const ALLOWED_HTML_ATTRS = new Set([
  "id",
  "class",
  "style",
  "title",
  "lang",
  "dir",
  "hidden",
  "tabindex",
  "role",
  "slot",
  "translate",
  "draggable",
  "contenteditable",
  "width",
  "height",
  "src",
  "alt",
  "loading",
  "decoding",
  "crossorigin",
  "preload",
  "autoplay",
  "loop",
  "muted",
  "controls",
  "poster",
  "playsinline",
]);

function isAllowedHtmlAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (ALLOWED_HTML_ATTRS.has(lower)) return true;
  if (lower.startsWith("data-")) return true;
  if (lower.startsWith("aria-")) return true;
  return false;
}

function isSafeAttributeValue(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "src" || lower === "href" || lower === "action" || lower === "formaction") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.startsWith("javascript:") || trimmed.startsWith("vbscript:")) return false;
  }
  return true;
}

export function patchElementInHtml(
  source: string,
  target: SourceMutationTarget,
  operations: PatchOperation[],
): string {
  const { document, wrappedFragment } = parseSourceDocument(source);
  const el = findTargetElement(document, target);
  if (!el || !isHTMLElement(el)) return source;
  const htmlEl = el as unknown as HTMLElement;

  for (const op of operations) {
    switch (op.type) {
      case "inline-style":
        if (op.value != null) {
          htmlEl.style.setProperty(op.property, op.value);
        } else {
          htmlEl.style.removeProperty(op.property);
        }
        break;
      case "attribute":
        if (op.value != null) {
          htmlEl.setAttribute(`data-${op.property}`, op.value);
        } else {
          htmlEl.removeAttribute(`data-${op.property}`);
        }
        break;
      case "html-attribute":
        if (!isAllowedHtmlAttribute(op.property)) break;
        if (op.value != null) {
          if (!isSafeAttributeValue(op.property, op.value)) break;
          htmlEl.setAttribute(op.property, op.value);
        } else {
          htmlEl.removeAttribute(op.property);
        }
        break;
      case "text-content":
        if (op.value != null) htmlEl.textContent = op.value;
        break;
    }
  }

  return wrappedFragment ? document.body.innerHTML || "" : document.toString();
}
