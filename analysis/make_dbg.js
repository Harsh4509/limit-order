const fs = require("fs");
let s = fs.readFileSync("spec_diff_batch.js", "utf8");
const log = `if (trial === 23 || trial === 4 || trial === 7)
      console.log("T" + trial, "kind", kind, "mask", mask, "sides", sides.join(""),
        "orders", orders.map((o) => o.tick.toString() + ":" + o.amount.toString()).join(" "),
        "| liveR", REF.s.live.map((l, i) => l ? REF.s.tick[i].toString() + "/" + REF.s.open[i].toString() + "q" + REF.s.q[i].toString() + "D" + REF.s.side[i] + "b" + REF.s.base[i].toString() : ".").join(","),
        "| qIn", REF.s.qIn.toString(), "qOut", REF.s.qOut.toString());
    `;
s = s.replace("    const eR = refOp(REF.s, kind, orders, sides, mask, c);", log + "    const eR = refOp(REF.s, kind, orders, sides, mask, c);");
fs.writeFileSync("spec_dbg.js", s);
console.log("written");
