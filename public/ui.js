// Small DOM helpers shared by dashboard controls. No application state lives here.
export function observeStickyTop(top) {
  // Measure in CSS pixels so wrapped controls, notices, and zoom all share the
  // same offset. No scroll handler: CSS handles pinning and group handoff.
  let height = 0;
  const update = () => {
    const scale = height ? top.getBoundingClientRect().height / height : 1;
    const style = document.documentElement.style;
    style.setProperty('--sticky-top-height', `${height}px`);
    style.setProperty('--sticky-viewport-height', `${window.innerHeight / (scale || 1)}px`);
  };
  const observer = new ResizeObserver(([entry]) => {
    height = entry.borderBoxSize[0].blockSize;
    update();
  });
  observer.observe(top);
  window.addEventListener('resize', update);
  return () => { observer.disconnect(); window.removeEventListener('resize', update); };
}

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const svgNamespace = 'http://www.w3.org/2000/svg';
function svgElement(tag, attributes) {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

// The file-diff path is GitHub Octicons (MIT); see THIRD_PARTY_NOTICES.
const paths = {
  'chevron-down': 'm4 6 4 4 4-4',
  'copy': 'M5 3V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1 M2 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  'files': 'M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z',
  'edit': 'M10 3l3 3M2 11l-1 4 4-1L14 5a2.12 2.12 0 0 0-3-3Z',
  'comment': 'M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-4 3v-3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
};

export function icon(name, size = 16) {
  const svg = svgElement('svg', {
    viewBox: '0 0 16 16', width: size, height: size,
    'aria-hidden': 'true', focusable: 'false',
    ...(name === 'files' ? { fill: 'currentColor' } : {
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }),
  });
  if (name === 'issue' || name === 'issue-closed') {
    svg.append(svgElement('circle', { cx: 8, cy: 8, r: 6 }));
    svg.append(name === 'issue' ? svgElement('circle', { cx: 8, cy: 8, r: 1, fill: 'currentColor', stroke: 'none' })
      : svgElement('path', { d: 'm5 8 2 2 4-4' }));
  } else if (name === 'clock') {
    svg.append(svgElement('circle', { cx: 8, cy: 8, r: 6 }), svgElement('path', { d: 'M8 4v4l2.5 1.5' }));
  } else {
    if (!paths[name]) throw new Error(`Unknown icon: ${name}`);
    svg.append(svgElement('path', { d: paths[name] }));
  }
  return svg;
}

export function clipboardFeedback(button, { text, symbol = button, feedback, success }) {
  const original = [...symbol.childNodes];
  const title = button.title;
  let timer;
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text);
      symbol.textContent = '✓';
      button.title = success;
    } catch {
      symbol.textContent = '!';
      button.title = 'Could not copy. Allow clipboard access and retry.';
    }
    feedback.textContent = button.title;
    timer = setTimeout(() => {
      symbol.replaceChildren(...original);
      button.title = title;
      feedback.textContent = '';
    }, 2000);
  });
}
