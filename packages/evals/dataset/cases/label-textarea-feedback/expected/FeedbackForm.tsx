export default function FeedbackForm() {
  return (
    <form action="/feedback" method="post">
      <label htmlFor="delivery-feedback">How was your delivery?</label>
      <textarea id="delivery-feedback" name="feedback" rows={4} />
      <button type="submit">Send feedback</button>
    </form>
  );
}
