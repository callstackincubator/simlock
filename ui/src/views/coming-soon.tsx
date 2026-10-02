/** A view whose data has not been built yet. */
export function ComingSoon({ title }: { readonly title: string }) {
  return (
    <section className="view">
      <h1>{title}</h1>
      <p className="muted">Coming soon.</p>
    </section>
  );
}
