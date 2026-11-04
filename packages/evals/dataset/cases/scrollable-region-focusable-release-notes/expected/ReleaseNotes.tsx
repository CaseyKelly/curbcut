export default function ReleaseNotes() {
  return (
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading">What changed</h2>
      <div style={{ height: 60, width: 240, overflow: 'auto' }} tabIndex={0}>
        <p>Added watering reminders to every plant page.</p>
        <p>Fixed a bug that reset your wishlist on sign-out.</p>
        <p>Delivery estimates now include public holidays.</p>
        <p>Plant care guides load faster on slow connections.</p>
      </div>
    </section>
  );
}
