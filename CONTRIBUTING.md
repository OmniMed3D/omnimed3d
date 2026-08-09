# Contributing to OmniMed3D

This document is a set of contribution guidelines established to maintain consistent code quality and promote efficient collaboration across the OmniMed3D project. All contributors working within the monorepo environment must comply with the rules below.

---

## 1. Branch Strategy

The project adopts the **GitHub Flow** strategy for rapid deployment and flexible management. All development work branches off from `main`, and upon completion is merged back into `main` via a Pull Request (PR).

### 1.1. Branch Naming Convention
To clearly distinguish modules, we use the **`Type/Part-Description`** pattern. All branch names must consist only of lowercase English letters and hyphens (`-`).

* **Type:**
  * `feat`: New feature development
  * `fix`: Bug fix
  * `refactor`: Code structure improvement with no functional change
  * `docs`: Documentation changes
  * `chore`: Build scripts, CI/CD, package configuration changes
* **Part:**
  * `engine`: C++ / WebGPU rendering core
  * `viewer`: Frontend web viewer
  * `ai`: Python / segmentation and inference server
  * `infra`: Docker and deployment infrastructure

**[Examples]**
* `feat/engine-dicom-parser`
* `fix/ai-inference-timeout`
* `chore/infra-docker-compose`

---

## 2. Commit Message Convention

We follow **Conventional Commits**, a global open-source standard. All commit messages must be written in English for future logging and automation tooling integration.

### 2.1. Message Structure

    <type>: <description>

* **Type:** Uses the same classification tags as branch naming.
* **Description:** A concise English description that clearly explains the change. Prioritize accurate tag (Type) classification and intuitive communication of the work over grammatical perfection.

**[Examples]**
* `feat: add WebGPU raymarching pipeline`
* `fix: resolve memory leak in dicom parsing`
* `chore: update github actions for wasm build`

---

## 3. Coding Standards

Language-specific standard conventions are enforced to maximize code readability and maintainability.

### 3.1. C++ (Engine module)
* **Standard:** Google C++ Style Guide
* **Automation:** Use the `.clang-format` configuration included at the repository root. Formatting must be applied before every commit.

### 3.2. Python (AI Server / Infra modules)
* **Standard:** PEP 8
* **Automation:** `Black` is used as the standard Python code formatter (auto-format via the `black .` command).

---

## 4. Pull Request (PR) Process

To merge work into `main`, the following PR process must be completed.

1. **Sync:** Before creating a PR, merge the latest commits from `main` and resolve any conflicts.
2. **Fill out the template:** Fill out the key sections of the provided PR template (summary of work and review notes) concisely and clearly.
3. **Code Review (CODEOWNERS):** Reviewers are automatically assigned to the relevant module owners according to the `.github/CODEOWNERS` rules.
   * Changes to `engine/`, `viewer/`: @nowead
   * Changes to `ai-pipeline/`, `infra/`: @hyuniverse
4. **Merge Policy:** Merge requirements are split by scope of work to maintain velocity for a small team.
   * **Core architecture changes (`feat`, `refactor`):** Merge only after approval from the designated reviewer and a passing CI build.
   * **Simple fixes and maintenance (`fix`, `docs`, `chore`):** May be self-merged by the author once the CI build passes, without requiring explicit reviewer approval.
