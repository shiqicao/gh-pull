import { SVG } from './vendor/svg.js';

// The gutter follows the handoff geometry, but each edge is one SVG path across
// all intervening rows to avoid seams at fractional zoom and variable row heights.
export function drawDependencies(groups) {
  const drawings = groups.map(({ list, graph }) => ({ list, graph,
    canvas: SVG().addTo(list.parentElement).addClass('dependency-connector')
      .attr({ 'aria-hidden': 'true', focusable: 'false' }),
  }));
  const x = lane => 16 + 20 * lane;
  const stroke = { color: 'var(--lane-line)', width: 2, linecap: 'butt', linejoin: 'round' };
  function draw() {
    for (const { list, graph, canvas } of drawings) {
      canvas.clear();
      if (!list.getClientRects().length || !list.offsetHeight) continue;
      const entries = [...list.children];
      // Align with the real row's first status pill, even when the title wraps.
      const centers = entries.map(entry => {
        const row = entry.getBoundingClientRect();
        const badge = entry.querySelector('.title-line > .badge')?.getBoundingClientRect();
        const scale = row.height / entry.offsetHeight;
        return entry.offsetTop + (badge && scale ? (badge.top + badge.height / 2 - row.top) / scale : 22);
      });
      canvas.node.style.left = `${list.offsetLeft}px`;
      canvas.node.style.top = `${list.offsetTop}px`;
      canvas.size(graph.gutter, list.offsetHeight);
      const arrow = (cx, top) => canvas.polygon([[cx, top], [cx + 5, top + 7], [cx - 5, top + 7]])
        .fill('var(--lane-arrow)').addClass('dependency-arrow');
      graph.rows.forEach((node, i) => {
        if (node.lane === null || node.lane > 3) return;
        const cx = x(node.lane), cy = centers[i];
        if (node.parentIndex >= 0) {
          const parent = graph.rows[node.parentIndex], py = centers[node.parentIndex];
          const px = x(parent.lane);
          const path = node.lane === parent.lane
            ? `M${cx} ${py + 5} V${cy - 5}`
            : `M${px} ${py} H${cx - 8} Q${cx} ${py} ${cx} ${py + 8} V${cy - 5}`;
          canvas.path(path).fill('none').stroke(stroke).addClass('dependency-edge');
          arrow(cx, py + (node.lane === parent.lane ? 7 : 12));
        } else if (node.externalParent || node.unloadedBase) {
          canvas.path(`M${cx} ${cy - 16} V${cy - 5}`).fill('none')
            .stroke({ ...stroke, dasharray: '3 2' }).addClass('dependency-external');
        }
      });
      // Paint nodes last so horizontal branch lines terminate behind their rings.
      graph.rows.forEach((node, i) => {
        if (node.lane === null || node.lane > 3) return;
        const color = `var(--lane-${node.nodeStatus})`;
        canvas.circle(8).center(x(node.lane), centers[i])
          .fill(node.parentIndex < 0 ? color : 'var(--color-page)')
          .stroke({ color, width: 2 }).addClass('dependency-dot')
          .attr({ 'data-pr-id': node.pr.id, 'data-lane': node.lane, 'data-status': node.nodeStatus });
      });
    }
  }
  const observer = new ResizeObserver(draw);
  for (const { list } of drawings) {
    observer.observe(list);
    for (const entry of list.children) observer.observe(entry);
  }
  draw();
  return () => {
    observer.disconnect();
    for (const { canvas } of drawings) canvas.remove();
  };
}
