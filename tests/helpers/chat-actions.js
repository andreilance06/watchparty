function openMessageActions(el, article) {
  article.dispatch("contextmenu", { clientX: 100, clientY: 100 });
  return el("messageMenu");
}
function replyTo(el, article) {
  openMessageActions(el, article).querySelectorAll(".message-menu-action")
    .find(button => button.textContent.includes("Reply")).click();
}
function expandReactions(el, article) {
  const menu = openMessageActions(el, article);
  menu.querySelector('[aria-label="More reactions"]').click();
  return menu.querySelector(".message-menu-expanded");
}
function openGlobalPicker(el) {
  el("chatEmojiButton").click();
  el("emojiGlobalTab").click();
}
module.exports = { openMessageActions, replyTo, expandReactions, openGlobalPicker };
