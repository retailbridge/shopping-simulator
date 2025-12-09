// src/data/products.ts

export type ProductId =
  | "redApple"
  | "pear"
  | "cerealCocoaCritters"
  | "chickenFriedRice"
  | "chickenStrips"
  | "fleeceJacket"
  | "glasses"
  | "goldBar"
  | "industrialShoe"
  | "presentBox"
  | "shoe"
  | "plantSansevieria";

export interface ProductDef {
  id: ProductId;
  name: string;
  category: string;
  price: number; // simple placeholder price for now
}

// Canonical product registry
export const PRODUCTS: Record<ProductId, ProductDef> = {
  redApple: {
    id: "redApple",
    name: "Apple",
    category: "Produce",
    price: 0.99,
  },
  pear: {
    id: "pear",
    name: "Pear",
    category: "Produce",
    price: 1.19,
  },
  cerealCocoaCritters: {
    id: "cerealCocoaCritters",
    name: "Cocoa Critters Cereal",
    category: "Breakfast & Snacks",
    price: 4.49,
  },
  chickenFriedRice: {
    id: "chickenFriedRice",
    name: "Chicken Fried Rice",
    category: "Ready Meals",
    price: 7.99,
  },
  chickenStrips: {
    id: "chickenStrips",
    name: "Chicken Strips",
    category: "Ready Meals",
    price: 6.49,
  },
  fleeceJacket: {
    id: "fleeceJacket",
    name: "Fleece Jacket",
    category: "Apparel",
    price: 49.0,
  },
  glasses: {
    id: "glasses",
    name: "Glasses",
    category: "Accessories",
    price: 79.0,
  },
  goldBar: {
    id: "goldBar",
    name: "Fine Gold Bar",
    category: "Luxury",
    price: 9999.0,
  },
  industrialShoe: {
    id: "industrialShoe",
    name: "Industrial Safety Shoe",
    category: "Workwear",
    price: 89.0,
  },
  presentBox: {
    id: "presentBox",
    name: "Gift Box",
    category: "Gifts",
    price: 14.99,
  },
  shoe: {
    id: "shoe",
    name: "Running Shoe",
    category: "Footwear",
    price: 79.0,
  },
  plantSansevieria: {
    id: "plantSansevieria",
    name: "Sansevieria Plant",
    category: "Home & Lifestyle",
    price: 19.99,
  },
};
