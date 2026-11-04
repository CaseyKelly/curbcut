export default function NewsletterForm() {
  return (
    <form action="/newsletter" method="post">
      <h2>Subscribe to our newsletter</h2>
      <label htmlFor="newsletter-email">Email address</label>
      <input id="newsletter-email" type="email" name="email" autoComplete="email" />
      <input type="submit" className="arrow-button" value="" />
    </form>
  );
}
