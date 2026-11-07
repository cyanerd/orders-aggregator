import { describe, expect, it } from "vitest";
import { applyDiscount, fromKop, parseKop, parsePercent, parseRub, toKop } from "../src/utils/money.js";

describe("parseRub", () => {
  it("принимает число и строку с числом", () => {
    expect(parseRub(2500)).toBe(2500);
    expect(parseRub("2500.00")).toBe(2500);
    expect(parseRub(" 99 ")).toBe(99);
  });

  it("отклоняет мусор и отрицательные суммы", () => {
    expect(() => parseRub("abc")).toThrow();
    expect(() => parseRub("")).toThrow();
    expect(() => parseRub("  ")).toThrow();
    expect(() => parseRub("0x10")).toThrow();
    expect(() => parseRub("1e3")).toThrow();
    expect(() => parseRub(null)).toThrow();
    expect(() => parseRub(-1)).toThrow();
  });
});

describe("toKop / fromKop", () => {
  it("рубли в копейки", () => {
    expect(toKop(2500)).toBe(250000);
    expect(toKop(99)).toBe(9900);
  });

  it("отбрасывает доли копейки", () => {
    expect(toKop(10.999)).toBe(1099);
  });

  it("копейки в рубли", () => {
    expect(fromKop(250000)).toBe(2500);
    expect(fromKop(1099)).toBe(10.99);
  });
});

describe("toKop: погрешность double", () => {
  it("не теряет копейку на суммах, которые не представимы точно", () => {
    expect(toKop(4723.9)).toBe(472390);
    expect(toKop(1.15)).toBe(115);
    expect(toKop(0.29)).toBe(29);
    expect(toKop(2375.22)).toBe(237522);
  });

  it("настоящие доли копейки отбрасывает даже у самой границы", () => {
    expect(toKop(10.999999999)).toBe(1099);
    expect(toKop(0.0099999)).toBe(0);
  });
});

describe("parsePercent", () => {
  it("число и строка", () => {
    expect(parsePercent(33)).toBe(33);
    expect(parsePercent("17")).toBe(17);
    expect(parsePercent(0)).toBe(0);
  });

  it("вне 0..100 и мусор — ошибка", () => {
    expect(() => parsePercent(-1)).toThrow();
    expect(() => parsePercent(101)).toThrow();
    expect(() => parsePercent("abc")).toThrow();
    expect(() => parsePercent("")).toThrow();
    expect(() => parsePercent("0x10")).toThrow();
    expect(() => parsePercent(12.345)).toThrow(); // в БД NUMERIC(5,2)
  });
});

describe("applyDiscount", () => {
  it("целочисленно, доли копейки отбрасывает", () => {
    expect(applyDiscount(100000, 15)).toBe(85000);
    expect(applyDiscount(1000, 99.9)).toBe(1); // в double 100 - 99.9 = 0.0999999999999943
    expect(applyDiscount(999, 33)).toBe(669); // 669.33
    expect(applyDiscount(500, 0)).toBe(500);
    expect(applyDiscount(500, 100)).toBe(0);
  });
});

describe("parseKop", () => {
  it("строку режет по десятичной записи, без double", () => {
    expect(parseKop("4723.8999999999999999")).toBe(472389);
    expect(parseKop("0.019999999999999999")).toBe(1);
    expect(parseKop(" 3100.00 ")).toBe(310000);
    expect(parseKop(4723.9)).toBe(472390);
  });

  it("отклоняет суммы, которые не помещаются точно (больше триллиона рублей)", () => {
    expect(parseKop(999_999_999_999.99)).toBe(99_999_999_999_999);
    expect(() => parseKop(1e12 + 1)).toThrow();
    expect(() => parseKop("123456789012345.67")).toThrow();
    expect(() => parseKop(1e21)).toThrow();
  });
});
