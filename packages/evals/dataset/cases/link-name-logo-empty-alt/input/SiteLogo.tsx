const SITE_NAME = 'Fernery';

export default function SiteLogo() {
  return (
    <header>
      <a href="/">
        <img src="/logo.svg" alt="" width="120" height="32" />
      </a>
      <p>Welcome to {SITE_NAME}</p>
    </header>
  );
}
