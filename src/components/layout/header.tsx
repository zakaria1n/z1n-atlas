import Image from "next/image";
import Link from "next/link";

export function Header() {
  return (
    <header className="header">
      <Link href="/" aria-label="Z1N Atlas home">
        <Image
          src="/assets/logo-horizontal.svg"
          alt=""
          width={180}
          height={45}
          priority
        />
      </Link>
      <nav aria-label="Main navigation">
        <Link href="/import">Explore</Link>
        <Link href="/settings">Settings</Link>
      </nav>
    </header>
  );
}
