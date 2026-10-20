export function whenNear(el: Element, start: () => void, margin = "200px") {
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      start();
    },
    { rootMargin: margin },
  );
  io.observe(el);
}
