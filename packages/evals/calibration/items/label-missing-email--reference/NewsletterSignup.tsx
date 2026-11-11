export default function NewsletterSignup() {
  return (
    <form className="signup" onSubmit={(e) => e.preventDefault()}>
      <h2>Get care tips by email</h2>
      <label htmlFor="signup-email">Email</label>
      <input id="signup-email" type="email" name="email" autoComplete="email" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
