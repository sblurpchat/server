// dice.js: "/roll 2d6" rolls dice, and only people with a verified email
// address may join. Copy it to <data>/plugins/ to install it. The bot is
// called "dice", after the file name.

function onJoin(member) {
  if (!member.email_verified) {
    return { allow: false, reason: "Verify your email address with your account provider, then join again." };
  }
}

function onCommand(name, args, ctx) {
  if (name !== "roll") return;
  const m = /^(\d*)d(\d+)$/.exec(args || "1d6");
  const count = Number(m?.[1] || 1), sides = Number(m?.[2]);
  if (!m || count < 1 || count > 100 || sides < 2 || sides > 1000) {
    return "Usage: /roll NdM, for example /roll 2d6 (up to 100 dice of up to 1000 sides)";
  }
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  const total = rolls.reduce((a, b) => a + b, 0);
  return `${ctx.author.display_name} rolled ${args || "1d6"}: ${rolls.join(" + ")} = ${total}`;
}
