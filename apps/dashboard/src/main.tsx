import { render } from "solid-js/web";
import { createDashboardStore } from "./data/store";
import { connect } from "./data/stream";
import { Stage } from "./view/Stage";

const store = createDashboardStore();
connect(store);

const root = document.getElementById("app");
if (!root) throw new Error("Dashboard root #app not found.");
render(() => <Stage store={store} />, root);
