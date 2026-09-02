import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPlaceName, placeAliases, relatedPlaceName } from "../scripts/place_name_utils.mjs";

test("canonicalPlaceName trims input and strips common place suffixes", () => {
  assert.equal(canonicalPlaceName(" 九洞天景区 "), "九洞天");
  assert.equal(canonicalPlaceName("盐津县城"), "盐津");
  assert.equal(canonicalPlaceName("北京市"), "北京");
});

test("canonicalPlaceName handles empty values conservatively", () => {
  assert.equal(canonicalPlaceName(null), "");
  assert.equal(canonicalPlaceName("  "), "");
  assert.equal(canonicalPlaceName("市"), "市");
});

test("canonicalPlaceName applies the first explicit custom alias before suffix cleanup", () => {
  const customAliases = {
    小七孔: ["荔波小七孔景区", "小七孔景区"],
  };

  assert.equal(canonicalPlaceName("小七孔", customAliases), "荔波小七孔");
});

test("placeAliases returns source, explicit aliases, and normalized variants sorted by specificity", () => {
  const customAliases = {
    小七孔: ["荔波小七孔景区"],
  };

  assert.deepEqual(placeAliases("小七孔", customAliases), ["荔波小七孔景区", "荔波小七孔", "小七孔"]);
  assert.deepEqual(placeAliases("盐津县城"), ["盐津县城", "盐津"]);
});

test("placeAliases ignores empty and one-character aliases", () => {
  assert.deepEqual(placeAliases(null), []);
  assert.deepEqual(placeAliases("市"), []);
});

test("placeAliases does not loop forever when custom aliases contain a cycle", () => {
  const customAliases = {
    A地: ["B地"],
    B地: ["A地"],
  };

  assert.deepEqual(placeAliases("A地", customAliases), ["A地", "B地"]);
});

test("relatedPlaceName matches aliases, normalized names, and containment", () => {
  const customAliases = {
    小七孔: ["荔波小七孔景区"],
  };

  assert.equal(relatedPlaceName("九洞天景区", "九洞天"), true);
  assert.equal(relatedPlaceName("小七孔", "荔波小七孔", customAliases), true);
  assert.equal(relatedPlaceName("黄果树瀑布景区", "黄果树瀑布东门"), true);
});

test("relatedPlaceName rejects empty and unrelated names", () => {
  assert.equal(relatedPlaceName("", "九洞天"), false);
  assert.equal(relatedPlaceName("九洞天", "织金洞"), false);
});
