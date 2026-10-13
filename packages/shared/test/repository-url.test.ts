import { describe, expect, it } from "vitest";
import { repositoryUrlProblem } from "../src/index";

describe("repositoryUrlProblem", () => {
  it("accepts clone URLs at their provider", () => {
    expect(repositoryUrlProblem("github", "https://github.com/acme/shop.git")).toBeNull();
    expect(repositoryUrlProblem("github", "https://github.com/acme/shop")).toBeNull();
    expect(repositoryUrlProblem("gitlab", "https://gitlab.com/group/sub/project.git")).toBeNull();
    expect(repositoryUrlProblem("git", "https://git.example.com/shop.git")).toBeNull();
  });

  it("refuses website addresses, wrong hosts, missing paths, credentials and queries", () => {
    expect(repositoryUrlProblem("github", "https://shop.preview.example.com")).toMatch(/github\.com/);
    expect(repositoryUrlProblem("github", "https://github.com/acme")).toMatch(/owner/);
    expect(repositoryUrlProblem("github", "https://github.com/acme/shop/tree/main")).toMatch(/owner/);
    expect(repositoryUrlProblem("gitlab", "https://gitlab.com/project")).toMatch(/group/);
    expect(repositoryUrlProblem("git", "https://git.example.com/")).toMatch(/website/);
    expect(repositoryUrlProblem("git", "https://user:pw@git.example.com/shop.git")).toMatch(/credentials/);
    expect(repositoryUrlProblem("git", "http://git.example.com/shop.git")).toMatch(/https/);
    expect(repositoryUrlProblem("github", "https://github.com/acme/shop.git#x")).toMatch(/query/);
  });
});
