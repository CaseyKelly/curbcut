export default function FeedbackForm() {
  return (
    <form action="/feedback" method="post">
      <p>How was your delivery?</p>
      <textarea id="delivery-feedback" name="feedback" rows={4} />
      <button type="submit">Send feedback</button>
    </form>
  );
}
