// The app's own pages. The main process picks one with the URL hash: #/welcome, #/import, #/into?id=,
// #/manage, #/upgrade?id=.
import { useEffect, useState } from "react";
import { ImportFlow } from "./ImportFlow.tsx";
import { Manage } from "./Manage.tsx";
import { Upgrade } from "./Upgrade.tsx";
import logoUrl from "../../viewer/web/shoebox-icon.svg";

function route() {
  const [page, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { page: page || "welcome", params: new URLSearchParams(query) };
}

export function Header({ title, lede }: { title: string; lede?: string }) {
  return (
    <header>
      <img src={logoUrl} alt="" />
      <div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
    </header>
  );
}

export function App() {
  const [r, setR] = useState(route);
  useEffect(() => {
    const onHash = () => setR(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  switch (r.page) {
    case "import":
      return <ImportFlow key="import" mode="new" />;
    case "into":
      return <ImportFlow key={`into-${r.params.get("id")}`} mode="into" collectionId={r.params.get("id") ?? ""} />;
    case "manage":
      return <Manage />;
    case "upgrade":
      return <Upgrade id={r.params.get("id") ?? ""} />;
    default:
      return <ImportFlow key="welcome" mode="new" welcome />;
  }
}
