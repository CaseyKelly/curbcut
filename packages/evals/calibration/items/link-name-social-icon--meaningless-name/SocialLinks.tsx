export default function SocialLinks() {
  return (
    <div className="social">
      <p>Follow us for weekly plant care tips.</p>
      <ul className="social-links">
        <li>
          <a href="https://www.instagram.com/fernleaf.example" aria-label="link">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2" y="2" width="16" height="16" rx="5" fill="none" stroke="currentColor" />
              <circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" />
            </svg>
          </a>
        </li>
        <li>
          <a href="/newsletter">Newsletter</a>
        </li>
      </ul>
    </div>
  );
}
