/**
 * Real-World Example: CI/CD Pipeline Analyzer
 * Analyzes build failures, test results, and deployment readiness
 */

const { extract, validate, summarize, decide, configure } = require('../src/index');

// Configure
configure({
  engines: {
    openai: process.env.OPENAI_API_KEY
  }
});

/**
 * Analyze CI/CD pipeline run
 */
async function analyzePipeline(pipelineData) {
  console.log('\n🔧 CI/CD Pipeline Analysis\n');

  // Step 1: Extract pipeline information
  console.log('1️⃣ Extracting pipeline data...');
  const pipelineInfo = await extract(pipelineData, {
    pipeline_name: {
      type: 'string',
      description: 'name of the pipeline or job'
    },
    branch: {
      type: 'string',
      description: 'git branch name'
    },
    commit_info: {
      type: 'object',
      description: 'commit hash, author, message'
    },
    build_status: {
      type: 'string',
      description: 'success, failed, unstable, aborted'
    },
    build_duration: {
      type: 'string',
      description: 'how long the build took'
    },
    stages: {
      type: 'array',
      description: 'pipeline stages and their status'
    },
    test_results: {
      type: 'object',
      description: 'passed, failed, skipped test counts'
    },
    failed_tests: {
      type: 'array',
      description: 'list of failed test names and errors'
    },
    code_coverage: {
      type: 'number',
      description: 'percentage of code covered by tests'
    },
    security_scan_results: {
      type: 'object',
      description: 'vulnerabilities found by security scanning'
    },
    artifacts_generated: {
      type: 'array',
      description: 'build artifacts produced'
    },
    error_logs: {
      type: 'array',
      description: 'key error messages from failed stages'
    },
    dependencies_changed: {
      type: 'array',
      description: 'any dependency updates in this build'
    },
    performance_metrics: {
      type: 'object',
      description: 'build time compared to average, test execution time'
    }
  });

  console.log('Pipeline Info:', JSON.stringify(pipelineInfo.data, null, 2));

  // Step 2: Validate deployment readiness
  console.log('\n2️⃣ Validating deployment readiness...');
  const readinessCheck = await validate(
    'Is this build ready for production deployment?',
    pipelineInfo.data,
    {
      deployment_criteria: [
        'All tests must pass',
        'Code coverage above 80%',
        'No critical security vulnerabilities',
        'Build time within normal range',
        'All quality gates passed',
        'No regression in performance tests',
        'Dependencies are stable versions',
        'Proper git commit message format',
        'Pull request approved by reviewers'
      ]
    }
  );

  console.log(`Deployment Readiness: ${(readinessCheck.score * 100).toFixed(1)}%`);
  console.log(`Assessment: ${readinessCheck.reasoning}`);

  // Step 3: Generate summary for team
  console.log('\n3️⃣ Creating summary...');
  const buildSummary = await summarize(
    {
      pipeline: pipelineInfo.data,
      readiness: readinessCheck
    },
    {
      maxLength: 200,
      focus: 'key_issues_and_next_steps'
    }
  );

  console.log('Summary:', buildSummary.summary);
  console.log('Key Points:', buildSummary.keyPoints);

  // Step 4: Decide on next action
  console.log('\n4️⃣ Determining next action...');
  const nextAction = await decide(
    {
      build_status: pipelineInfo.data.build_status,
      test_results: pipelineInfo.data.test_results,
      readiness_score: readinessCheck.score,
      branch: pipelineInfo.data.branch,
      security_issues: pipelineInfo.data.security_scan_results
    },
    [
      {
        action: 'deploy_to_production',
        description: 'Deploy to production environment'
      },
      {
        action: 'deploy_to_staging',
        description: 'Deploy to staging for further testing'
      },
      {
        action: 'fix_tests',
        description: 'Fix failing tests before proceeding'
      },
      {
        action: 'address_security',
        description: 'Fix security vulnerabilities first'
      },
      {
        action: 'improve_coverage',
        description: 'Increase test coverage before deployment'
      },
      {
        action: 'rollback_changes',
        description: 'Rollback problematic changes'
      },
      {
        action: 'manual_review',
        description: 'Requires manual review by senior engineer'
      },
      {
        action: 'retry_build',
        description: 'Retry build (likely flaky test or network issue)'
      }
    ]
  );

  console.log(`\n✅ Recommended Action: ${nextAction.action.replace(/_/g, ' ').toUpperCase()}`);
  console.log(`Reasoning: ${nextAction.reasoning}`);
  console.log(`Confidence: ${(nextAction.confidence * 100).toFixed(1)}%`);

  // Generate detailed report
  return {
    pipeline: {
      name: pipelineInfo.data.pipeline_name,
      branch: pipelineInfo.data.branch,
      status: pipelineInfo.data.build_status,
      duration: pipelineInfo.data.build_duration
    },
    quality: {
      tests: pipelineInfo.data.test_results,
      coverage: pipelineInfo.data.code_coverage,
      security: pipelineInfo.data.security_scan_results
    },
    readiness: {
      score: readinessCheck.score,
      ready: readinessCheck.score > 0.8,
      issues: readinessCheck.weaknesses || []
    },
    recommendation: {
      action: nextAction.action,
      reasoning: nextAction.reasoning,
      confidence: nextAction.confidence
    },
    summary: buildSummary.summary,
    notifications: generateNotifications(nextAction.action, pipelineInfo.data),
    jenkinsfile_suggestions: generateJenkinsfileSuggestions(pipelineInfo.data),
    pr_comment: generatePRComment(pipelineInfo.data, readinessCheck, nextAction)
  };
}

/**
 * Generate notifications
 */
function generateNotifications(action, pipelineData) {
  const notifications = [];

  switch (action) {
    case 'deploy_to_production':
      notifications.push({
        channel: '#releases',
        message: `✅ ${pipelineData.branch} ready for production deployment`
      });
      break;

    case 'fix_tests':
      notifications.push({
        channel: '#dev-team',
        message: `❌ Build failed: ${pipelineData.failed_tests?.length || 0} tests need fixing`
      });
      break;

    case 'address_security':
      notifications.push({
        channel: '#security',
        message: `🔒 Security vulnerabilities found in ${pipelineData.pipeline_name}`
      });
      break;
  }

  return notifications;
}

/**
 * Generate Jenkinsfile improvements
 */
function generateJenkinsfileSuggestions(pipelineData) {
  const suggestions = [];

  if (!pipelineData.stages?.includes('security')) {
    suggestions.push(`
stage('Security Scan') {
  steps {
    sh 'npm audit'
    sh 'snyk test'
  }
}`);
  }

  if (pipelineData.build_duration > '10 minutes') {
    suggestions.push(`
// Consider parallel stages for faster builds:
parallel {
  stage('Unit Tests') { ... }
  stage('Lint') { ... }
  stage('Security') { ... }
}`);
  }

  if (pipelineData.code_coverage < 80) {
    suggestions.push(`
// Add coverage gate:
post {
  always {
    publishHTML target: [
      allowMissing: false,
      alwaysLinkToLastBuild: false,
      keepAll: true,
      reportDir: 'coverage',
      reportFiles: 'index.html',
      reportName: 'Coverage Report'
    ]
    script {
      if (currentBuild.result == 'SUCCESS') {
        def coverage = sh(returnStdout: true, script: 'grep -o "[0-9]*%" coverage/index.html | head -1')
        if (coverage.toInteger() < 80) {
          error("Coverage \${coverage.toString()} is below 80% threshold")
        }
      }
    }
  }
}`);
  }

  return suggestions;
}

/**
 * Generate PR comment
 */
function generatePRComment(pipelineData, readiness, action) {
  const emoji = pipelineData.build_status === 'success' ? '✅' : '❌';
  const coverage = pipelineData.code_coverage ? `${pipelineData.code_coverage}%` : 'N/A';

  return `
## ${emoji} Build ${pipelineData.build_status.toUpperCase()}

### 📊 Metrics
- **Tests**: ${pipelineData.test_results?.passed || 0} passed, ${pipelineData.test_results?.failed || 0} failed
- **Coverage**: ${coverage} ${pipelineData.code_coverage < 80 ? '⚠️' : '✅'}
- **Duration**: ${pipelineData.build_duration}
- **Deployment Ready**: ${readiness.ready ? 'Yes ✅' : 'No ❌'}

### 🤖 AI Analysis
${readiness.reasoning}

### 📋 Recommendation
**${action.action.replace(/_/g, ' ').toUpperCase()}**
${action.reasoning}

${
  pipelineData.failed_tests?.length > 0
    ? `
### ❌ Failed Tests
${pipelineData.failed_tests
  .slice(0, 5)
  .map(t => `- ${t}`)
  .join('\n')}
`
    : ''
}

${
  pipelineData.security_scan_results?.critical > 0
    ? `
### 🔒 Security Issues
- Critical: ${pipelineData.security_scan_results.critical}
- High: ${pipelineData.security_scan_results.high}
`
    : ''
}
`;
}

// Test cases
const pipelineRuns = [
  {
    name: 'Successful Production-Ready Build',
    data: `
Pipeline: backend-api
Branch: main
Commit: abc123def by John Smith - "feat: Add user authentication"
Build #: 342
Status: SUCCESS
Duration: 8 minutes 32 seconds

Stages:
1. Checkout - SUCCESS (5s)
2. Install Dependencies - SUCCESS (45s)
3. Lint - SUCCESS (12s)
4. Unit Tests - SUCCESS (2m 15s)
5. Integration Tests - SUCCESS (3m 20s)
6. Security Scan - SUCCESS (1m 30s)
7. Build Docker Image - SUCCESS (45s)
8. Push to Registry - SUCCESS (30s)

Test Results:
- Passed: 245
- Failed: 0
- Skipped: 3
- Coverage: 87.3%

Security Scan:
- Critical: 0
- High: 0
- Medium: 2 (non-blocking)
- Low: 5

Performance Tests:
- API Response Time: 145ms avg (baseline: 150ms) ✅
- Throughput: 1200 req/s (baseline: 1000 req/s) ✅

Artifacts:
- backend-api:v2.3.4 (Docker image)
- test-reports.zip
- coverage-report.html
`
  },

  {
    name: 'Failed Build with Test Failures',
    data: `
Pipeline: frontend-app
Branch: feature/new-dashboard
Commit: xyz789abc by Sarah Johnson - "WIP: Dashboard components"
Build #: 157
Status: FAILED
Duration: 5 minutes 12 seconds

Stages:
1. Checkout - SUCCESS (3s)
2. Install Dependencies - SUCCESS (38s)
3. Lint - SUCCESS (8s)
4. Unit Tests - FAILED (3m 45s)
5. Integration Tests - SKIPPED
6. Build - SKIPPED

Test Results:
- Passed: 156
- Failed: 8
- Skipped: 45
- Coverage: 72.1%

Failed Tests:
- DashboardComponent.test.js - "should render user data" - Cannot read property 'name' of undefined
- ChartWidget.test.js - "should update on data change" - Timeout after 5000ms
- UserService.test.js - "should fetch user profile" - Expected 200, got 404
- AuthGuard.test.js - "should redirect unauthorized users" - Navigation not triggered
- DataTable.test.js - "should sort by column" - Array length mismatch
- ApiClient.test.js - "should retry on failure" - Mock not called
- Dashboard.integration.test.js - "should load dashboard" - Element not found
- MetricsCard.test.js - "should format numbers" - Expected "1.2K" got "1200"

Error Logs:
- "TypeError: Cannot read property 'name' of undefined at DashboardComponent.jsx:45"
- "Error: Network request failed at ApiClient.js:89"
- "Warning: React state update on unmounted component"

Recent Changes:
- Updated React from 17.0.2 to 18.2.0
- Added new Dashboard components
- Refactored API client
`
  },

  {
    name: 'Security Vulnerabilities Detected',
    data: `
Pipeline: payment-service
Branch: release/v3.0
Commit: def456ghi by Mike Chen - "chore: Update dependencies"
Build #: 89
Status: UNSTABLE
Duration: 11 minutes 5 seconds

Stages:
1. Checkout - SUCCESS (4s)
2. Install Dependencies - SUCCESS (1m 20s)
3. Lint - SUCCESS (15s)
4. Unit Tests - SUCCESS (4m 30s)
5. Integration Tests - SUCCESS (3m 15s)
6. Security Scan - UNSTABLE (2m 10s)
7. Build Docker Image - SUCCESS (50s)

Test Results:
- Passed: 389
- Failed: 0
- Skipped: 12
- Coverage: 91.2%

Security Scan Results:
- Critical: 2
  * CVE-2024-1234 in stripe-node@8.1.0 - Remote Code Execution
  * CVE-2024-5678 in jsonwebtoken@8.5.1 - Authentication Bypass
- High: 5
  * SQL Injection possibility in user input handling
  * Missing rate limiting on payment endpoints
  * Sensitive data in logs (credit card last 4 digits)
  * Weak encryption algorithm (MD5) used for tokens
  * CORS misconfiguration allowing any origin
- Medium: 8
- Low: 15

Dependency Updates in this Build:
- stripe-node: 7.15.0 -> 8.1.0
- express: 4.17.1 -> 4.18.2
- jsonwebtoken: 8.5.1 (no change, but vulnerable)
- bcrypt: 5.0.1 -> 5.1.1

Performance:
- Build time 25% slower than average
- Docker image size increased by 50MB
`
  }
];

// Run examples
async function runExamples() {
  for (const pipeline of pipelineRuns) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔧 PIPELINE: ${pipeline.name}`);
    console.log('='.repeat(60));

    try {
      const result = await analyzePipeline(pipeline.data);

      console.log('\n📋 PIPELINE ANALYSIS REPORT');
      console.log('==========================');
      console.log(`Pipeline: ${result.pipeline.name}`);
      console.log(`Branch: ${result.pipeline.branch}`);
      console.log(`Status: ${result.pipeline.status}`);
      console.log(`Deployment Ready: ${result.readiness.ready ? '✅ YES' : '❌ NO'}`);
      console.log(
        `\nRecommendation: ${result.recommendation.action.replace(/_/g, ' ').toUpperCase()}`
      );

      if (result.notifications.length > 0) {
        console.log('\n📢 Notifications:');
        result.notifications.forEach(n => {
          console.log(`  ${n.channel}: ${n.message}`);
        });
      }

      console.log('\n💬 PR Comment Preview:');
      console.log(result.pr_comment);
    } catch (error) {
      console.error('Error analyzing pipeline:', error.message);
    }
  }
}

// Export
module.exports = { analyzePipeline };

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
