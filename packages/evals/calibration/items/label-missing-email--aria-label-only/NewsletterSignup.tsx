export default function NewsletterSignup() {
  return (
    <form className="signup" onSubmit={(e) => e.preventDefault()}>
      <h2>Get care tips by email</h2>
      <input type="email" name="email" autoComplete="email" aria-label="Email" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
