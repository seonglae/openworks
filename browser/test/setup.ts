import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// happy-dom keeps one document per file, so a component left mounted by one
// test is still in the tree for the next one's queries.
afterEach(cleanup);
