/**
 * Visual editor inspector bridge.
 *
 * Shared between the app (which injects it into a fetched page) and the server
 * (which serves it at /visual-editor/bridge.js, so a dev app can load it from a
 * plain script tag and be inspected on its own origin, with routing intact).
 */

export interface InspectedElement {
  selector: string
  tagName: string
  id: string
  className: string
  innerText: string
  outerHTML: string
  detectedLanguage: "tsx" | "jsx" | "vue" | "svelte" | "html"
  rect: {
    top: number
    left: number
    width: number
    height: number
  }
  styles: {
    display: string
    flexDirection: string
    alignItems: string
    justifyContent: string
    gap: string
    padding: string
    margin: string
    color: string
    backgroundColor: string
    fontSize: string
    fontWeight: string
    lineHeight: string
    textAlign: string
    borderRadius: string
    borderWidth: string
    borderColor: string
    opacity: string
    boxShadow: string
    width: string
    height: string
  }
  parentSelector?: string
  siblingsCount?: number
  indexInParent?: number
}

export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info"
  message: string
  timestamp: number
}

export type BridgeMessage =
  | { type: "visual-editor:ready" }
  | { type: "visual-editor:element-hovered"; element: InspectedElement | null }
  | { type: "visual-editor:element-selected"; element: InspectedElement }
  | {
      type: "visual-editor:element-reordered"
      selector: string
      parentSelector: string
      oldIndex: number
      newIndex: number
      outerHTML: string
    }
  | { type: "visual-editor:console-log"; log: ConsoleEntry }
  | { type: "visual-editor:dom-changed" }
  | { type: "visual-editor:set-mode"; mode: "browse" | "edit" }
  | { type: "visual-editor:apply-style"; selector: string; property: string; value: string }
  | { type: "visual-editor:clear-selection"; selectors?: string[] }

export const INSPECTOR_BRIDGE_SCRIPT = `
(function() {
  if (window.__NIKCLI_INSPECTOR_ACTIVE__) return;
  window.__NIKCLI_INSPECTOR_ACTIVE__ = true;

  // Modes: 'browse' (normal browsing) | 'edit' (unified select-to-link & drag-and-drop)
  var currentMode = 'browse';
  var hoveredEl = null;
  var draggedEl = null;
  var isDragging = false;
  var dropTargetEl = null;
  var dropPosition = null; // 'before' | 'after'

  // Capture console logs and errors
  var originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info
  };

  function serializeArg(arg) {
    try {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') return JSON.stringify(arg);
      return String(arg);
    } catch(e) {
      return String(arg);
    }
  }

  function forwardConsole(level, args) {
    var msg = Array.prototype.slice.call(args).map(serializeArg).join(' ');
    window.parent.postMessage({
      type: 'visual-editor:console-log',
      log: {
        level: level,
        message: msg.slice(0, 1000),
        timestamp: Date.now()
      }
    }, '*');
  }

  console.log = function() {
    forwardConsole('log', arguments);
    originalConsole.log.apply(console, arguments);
  };
  console.warn = function() {
    forwardConsole('warn', arguments);
    originalConsole.warn.apply(console, arguments);
  };
  console.error = function() {
    forwardConsole('error', arguments);
    originalConsole.error.apply(console, arguments);
  };
  console.info = function() {
    forwardConsole('info', arguments);
    originalConsole.info.apply(console, arguments);
  };

  window.addEventListener('error', function(e) {
    forwardConsole('error', [e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || '')]);
  });

  window.addEventListener('unhandledrejection', function(e) {
    forwardConsole('error', ['Unhandled promise rejection: ' + serializeArg(e.reason)]);
  });

  // Highlight overlays
  var hoverOutline = document.createElement('div');
  hoverOutline.id = '__nikcli_hover_outline';
  hoverOutline.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);z-index:999999;display:none;border-radius:3px;transition:all 0.05s ease;';
  
  var hoverBadge = document.createElement('div');
  hoverBadge.id = '__nikcli_hover_badge';
  hoverBadge.style.cssText = 'position:fixed;pointer-events:none;background:#2563eb;color:#ffffff;font-size:11px;font-weight:600;font-family:ui-sans-serif,system-ui,sans-serif;line-height:1;padding:4px 7px;border-radius:3px 3px 0 0;z-index:1000000;display:none;';

  var dropIndicator = document.createElement('div');
  dropIndicator.id = '__nikcli_drop_indicator';
  dropIndicator.style.cssText = 'position:fixed;pointer-events:none;background:#10b981;z-index:999999;display:none;border-radius:2px;box-shadow:0 0 8px rgba(16,185,129,0.8);';

  // Elements the host has attached to the chat stay outlined so a multi-element
  // selection is visible while the user keeps clicking.
  var selectedEls = [];
  var selectionLayer = document.createElement('div');
  selectionLayer.id = '__nikcli_selection_layer';
  selectionLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999998;display:block;';

  function renderSelection() {
    selectionLayer.innerHTML = '';
    for (var i = 0; i < selectedEls.length; i++) {
      var rect = selectedEls[i].getBoundingClientRect();
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,0.10);border-radius:3px;top:' +
        rect.top + 'px;left:' + rect.left + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
      selectionLayer.appendChild(box);
    }
  }

  window.addEventListener('scroll', renderSelection, true);
  window.addEventListener('resize', renderSelection);

  function attachOverlays() {
    if (document.body && !document.getElementById('__nikcli_hover_outline')) {
      document.body.appendChild(hoverOutline);
      document.body.appendChild(hoverBadge);
      document.body.appendChild(dropIndicator);
      document.body.appendChild(selectionLayer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachOverlays);
  } else {
    attachOverlays();
  }

  function detectLanguage() {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (src.indexOf('.tsx') !== -1 || src.indexOf('tsx') !== -1) return 'tsx';
      if (src.indexOf('.jsx') !== -1 || src.indexOf('jsx') !== -1) return 'jsx';
      if (src.indexOf('.vue') !== -1 || src.indexOf('vue') !== -1) return 'vue';
      if (src.indexOf('.svelte') !== -1 || src.indexOf('svelte') !== -1) return 'svelte';
    }
    return 'tsx';
  }

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    
    var path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      if (el === document.body || el === document.documentElement) {
        path.unshift(el.nodeName.toLowerCase());
        break;
      }
      var selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += '#' + CSS.escape(el.id);
        path.unshift(selector);
        break;
      } else if (el.className && typeof el.className === 'string') {
        var classes = el.className.trim().split(/\\s+/).filter(function(c) {
          return c && !c.startsWith('__nikcli');
        });
        if (classes.length > 0) {
          selector += '.' + CSS.escape(classes[0]);
        }
      }
      
      var sib = el, nth = 1;
      while (sib = sib.previousElementSibling) {
        if (sib.nodeName.toLowerCase() === el.nodeName.toLowerCase()) nth++;
      }
      if (nth > 1) selector += ":nth-of-type(" + nth + ")";

      path.unshift(selector);
      el = el.parentElement;
    }
    return path.join(" > ");
  }

  function getCleanOuterHTML(el) {
    if (!el) return '';
    var clone = el.cloneNode(false);
    var html = clone.outerHTML || '';
    if (html.length > 300) {
      html = html.slice(0, 300) + '...';
    }
    return html;
  }

  function serializeElement(el) {
    if (!el || el === hoverOutline || el === hoverBadge || el === dropIndicator) return null;
    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var parent = el.parentElement;

    return {
      selector: getUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className ? (typeof el.className === 'string' ? el.className : '') : '',
      innerText: (el.innerText || '').slice(0, 80).trim(),
      outerHTML: getCleanOuterHTML(el),
      detectedLanguage: detectLanguage(),
      rect: {
        top: rect.top,
        left: rect.left,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      styles: {
        display: cs.display,
        flexDirection: cs.flexDirection,
        alignItems: cs.alignItems,
        justifyContent: cs.justifyContent,
        gap: cs.gap,
        padding: cs.padding,
        margin: cs.margin,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        textAlign: cs.textAlign,
        borderRadius: cs.borderRadius,
        borderWidth: cs.borderWidth,
        borderColor: cs.borderColor,
        opacity: cs.opacity,
        boxShadow: cs.boxShadow,
        width: cs.width,
        height: cs.height
      },
      parentSelector: parent ? getUniqueSelector(parent) : undefined,
      siblingsCount: parent ? parent.children.length : 0,
      indexInParent: parent ? Array.prototype.indexOf.call(parent.children, el) : 0
    };
  }

  function updateHoverOverlay(el) {
    attachOverlays();
    if (!el || currentMode !== 'edit' || isDragging) {
      hoverOutline.style.display = 'none';
      hoverBadge.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    hoverOutline.style.display = 'block';
    hoverOutline.style.top = rect.top + 'px';
    hoverOutline.style.left = rect.left + 'px';
    hoverOutline.style.width = rect.width + 'px';
    hoverOutline.style.height = rect.height + 'px';

    hoverBadge.textContent = el.tagName.toLowerCase();
    hoverBadge.style.display = 'block';
    // Flush against the top-left corner of the outline, like a tab on it.
    hoverBadge.style.top = Math.max(0, rect.top - 19) + 'px';
    hoverBadge.style.left = Math.max(0, rect.left) + 'px';
  }

  // Mousemove highlight in Edit mode
  document.addEventListener('mousemove', function(e) {
    if (currentMode !== 'edit') {
      hoverOutline.style.display = 'none';
      hoverBadge.style.display = 'none';
      return;
    }
    if (isDragging) return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === document.documentElement || target === document.body || target === hoverOutline || target === hoverBadge || target === dropIndicator) {
      if (hoveredEl) {
        hoveredEl = null;
        updateHoverOverlay(null);
      }
      return;
    }
    if (target !== hoveredEl) {
      hoveredEl = target;
      updateHoverOverlay(target);
    }
  }, true);

  // Mousedown to prepare drag & drop in Edit mode
  document.addEventListener('mousedown', function(e) {
    if (currentMode !== 'edit') return;
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === document.body || target === document.documentElement) return;
    draggedEl = target;
    draggedEl.setAttribute('draggable', 'true');
    isDragging = false;
  }, true);

  // A plain click never fires dragend, so the attribute would otherwise stay on
  // the host page's element after the editor is closed.
  document.addEventListener('mouseup', function() {
    if (draggedEl && !isDragging) draggedEl.removeAttribute('draggable');
  }, true);

  document.addEventListener('dragstart', function(e) {
    if (currentMode !== 'edit' || !draggedEl) return;
    isDragging = true;
    e.dataTransfer.setData('text/plain', getUniqueSelector(draggedEl));
    e.dataTransfer.effectAllowed = 'move';
    draggedEl.style.opacity = '0.4';
    hoverOutline.style.display = 'none';
    hoverBadge.style.display = 'none';
  }, true);

  document.addEventListener('dragover', function(e) {
    if (currentMode !== 'edit' || !draggedEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === draggedEl || target === document.body || target === document.documentElement) {
      dropIndicator.style.display = 'none';
      return;
    }

    dropTargetEl = target;
    var rect = target.getBoundingClientRect();
    var midY = rect.top + rect.height / 2;

    dropIndicator.style.display = 'block';
    dropIndicator.style.left = rect.left + 'px';
    dropIndicator.style.width = rect.width + 'px';
    dropIndicator.style.height = '3px';

    if (e.clientY < midY) {
      dropPosition = 'before';
      dropIndicator.style.top = (rect.top - 1) + 'px';
    } else {
      dropPosition = 'after';
      dropIndicator.style.top = (rect.bottom - 1) + 'px';
    }
  }, true);

  document.addEventListener('dragend', function(e) {
    if (draggedEl) {
      draggedEl.style.opacity = '1';
      draggedEl.removeAttribute('draggable');
    }
    dropIndicator.style.display = 'none';
    setTimeout(function() {
      isDragging = false;
    }, 50);
  }, true);

  document.addEventListener('drop', function(e) {
    if (currentMode !== 'edit' || !draggedEl || !dropTargetEl) return;
    e.preventDefault();
    e.stopPropagation();

    var parent = dropTargetEl.parentElement;
    if (parent && draggedEl !== dropTargetEl) {
      var oldIndex = Array.prototype.indexOf.call(parent.children, draggedEl);
      if (dropPosition === 'before') {
        parent.insertBefore(draggedEl, dropTargetEl);
      } else {
        parent.insertBefore(draggedEl, dropTargetEl.nextElementSibling);
      }
      var newIndex = Array.prototype.indexOf.call(parent.children, draggedEl);

      window.parent.postMessage({
        type: 'visual-editor:element-reordered',
        selector: getUniqueSelector(draggedEl),
        parentSelector: getUniqueSelector(parent),
        oldIndex: oldIndex,
        newIndex: newIndex,
        outerHTML: getCleanOuterHTML(draggedEl)
      }, '*');

      window.parent.postMessage({ type: 'visual-editor:dom-changed' }, '*');
    }

    if (draggedEl) {
      draggedEl.style.opacity = '1';
      draggedEl.removeAttribute('draggable');
    }
    draggedEl = null;
    dropTargetEl = null;
    dropIndicator.style.display = 'none';
    setTimeout(function() {
      isDragging = false;
    }, 50);
  }, true);

  // Click handler (Select & Link on click if not dragging)
  document.addEventListener('click', function(e) {
    if (currentMode !== 'edit') return;
    if (isDragging) return; // ignore click if user just dropped an element
    e.preventDefault();
    e.stopPropagation();

    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === hoverOutline || target === hoverBadge || target === dropIndicator) return;

    var serialized = serializeElement(target);
    if (serialized) {
      if (selectedEls.indexOf(target) === -1) selectedEls.push(target);
      renderSelection();
      window.parent.postMessage({
        type: 'visual-editor:element-selected',
        element: serialized
      }, '*');
    }
    hoverOutline.style.display = 'none';
    hoverBadge.style.display = 'none';
  }, true);

  // Message listener from parent host
  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'visual-editor:set-mode') {
      currentMode = e.data.mode;
      if (currentMode === 'browse') {
        hoverOutline.style.display = 'none';
        hoverBadge.style.display = 'none';
        dropIndicator.style.display = 'none';
      }
    } else if (e.data.type === 'visual-editor:clear-selection') {
      // With a selectors list the host is pruning individual chips; without one
      // the whole selection is being dropped.
      if (Array.isArray(e.data.selectors)) {
        selectedEls = selectedEls.filter(function(el) {
          return e.data.selectors.indexOf(getUniqueSelector(el)) !== -1;
        });
      } else {
        selectedEls = [];
      }
      renderSelection();
    } else if (e.data.type === 'visual-editor:apply-style') {
      var el = document.querySelector(e.data.selector);
      if (el) {
        el.style[e.data.property] = e.data.value;
      }
    }
  });

  // Notify parent that bridge is ready
  window.parent.postMessage({ type: 'visual-editor:ready' }, '*');
})();
`;
