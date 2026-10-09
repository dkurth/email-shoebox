import { createRoot } from "react-dom/client";

function Placeholder() {
  return <p>Mail archive viewer: the server is running.</p>;
}

createRoot(document.getElementById("root")!).render(<Placeholder />);
