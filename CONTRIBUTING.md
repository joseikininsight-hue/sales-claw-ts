# Contributing to Sales Claw

Thank you for your interest in contributing!

## How to Contribute

1. **Fork** the repository
2. **Create a branch** for your feature or fix: `git checkout -b feature/my-feature`
3. **Make your changes** and test them
4. **Commit** with a descriptive message: `git commit -m "feat: add new feature"`
5. **Push** to your fork: `git push origin feature/my-feature`
6. **Open a Pull Request** with a clear description of your changes

## Development Setup

```bash
git clone https://github.com/<your-org>/sales-claw.git
cd sales-claw
npm install
# Windows (PowerShell): Copy-Item data/sample-settings.json data/settings.json
# macOS / Linux: cp data/sample-settings.json data/settings.json
npx playwright install chromium
npm start
```

デスクトップ版の動作確認は `npm start`、ローカルダッシュボード単体の確認は `npm run dashboard` を使います。

## Release

- `package.json` の version を更新する
- 必要な README / docs / release notes を更新する
- `git tag v<version>` を作成して push する
- `.github/workflows/release.yml` が GitHub Releases を作成する

一般ユーザー向け成果物は GitHub Releases のインストーラー / DMG / AppImage です。

## Code Style

- Use CommonJS (`require`/`module.exports`)
- Use `const` by default, `let` when reassignment is needed
- Functions should be small (<50 lines)
- Files should be focused (<800 lines)
- Handle errors explicitly
- No hardcoded values — use settings-manager.cjs

## Commit Message Format

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

## Reporting Issues

- Use GitHub Issues
- Include steps to reproduce
- Include expected vs actual behavior
- Include Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
