// Declarative Jenkins mirror of .github/workflows/llm-tests.yml
// Plugins: Docker Pipeline, JUnit, HTML Publisher, Credentials Binding.
// Live run: store the key as a "Secret text" credential with id `llm-api-key`.

pipeline {
  agent {
    docker {
      image 'node:20'
      args '-e HOME=/tmp'
    }
  }

  parameters {
    booleanParam(name: 'LIVE', defaultValue: false, description: 'Also run against the real provider (credential llm-api-key)')
  }

  triggers {
    cron(env.BRANCH_NAME == 'main' ? 'H 3 * * 1-5' : '') // nightly drift detection
  }

  options {
    timeout(time: 30, unit: 'MINUTES')
    timestamps()
    disableConcurrentBuilds(abortPrevious: true)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    CI = 'true'
    LLM_PROVIDER = 'mock' // deterministic, free, no secrets
    npm_config_cache = "${WORKSPACE}/.npm"
  }

  stages {
    stage('Install') {
      steps {
        sh 'npm ci --no-audit --no-fund'
      }
    }

    stage('Lint, types & validate') {
      steps {
        sh 'npm run lint'
        sh 'npm run typecheck'
        sh 'npm run validate'
      }
    }

    stage('Unit tests') {
      steps {
        sh 'npm run test:unit'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'reports/unit-junit.xml'
        }
      }
    }

    stage('Checks') {
      parallel {
        stage('LLM evals (mock)') {
          steps {
            sh 'npm run test:llm'
            sh 'npx llm-harness gate reports/results.json'
          }
          post {
            always {
              junit allowEmptyResults: true, testResults: 'reports/junit.xml'
              publishHTML(target: [
                reportName: 'LLM evaluation report',
                reportDir: 'reports',
                reportFiles: 'report.html',
                keepAll: true,
                alwaysLinkToLastBuild: true,
                allowMissing: true,
              ])
              publishHTML(target: [
                reportName: 'Playwright report',
                reportDir: 'reports/playwright',
                reportFiles: 'index.html',
                keepAll: true,
                allowMissing: true,
              ])
              archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
            }
          }
        }

        stage('Gate self-test') {
          environment {
            LLM_MOCK_RESPONSES = 'test_data/mock/responses.yaml,test_data/mock/faulty.yaml'
            LLM_REPORTS_DIR = 'reports-faulty'
          }
          steps {
            sh '''
              if npx llm-harness run; then
                echo "Quality gate accepted a model with known regressions"; exit 1
              fi
              echo "Gate correctly rejected the faulty model"
            '''
          }
        }
      }
    }

    stage('LLM evals (live)') {
      when {
        anyOf {
          expression { params.LIVE }
          triggeredBy 'TimerTrigger'
        }
      }
      environment {
        LLM_PROVIDER = 'openai'
        LLM_MODEL = 'gpt-4o-mini'
        LLM_SOFT_FAIL = 'true'
        LLM_GATE = 'true'
        LLM_WORKERS = '2'
        LLM_REPORTS_DIR = 'reports-live'
      }
      steps {
        withCredentials([string(credentialsId: 'llm-api-key', variable: 'LLM_API_KEY')]) {
          sh 'npm run test:llm'
        }
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'reports/junit.xml'
          publishHTML(target: [
            reportName: 'LLM evaluation report (live)',
            reportDir: 'reports-live',
            reportFiles: 'report.html',
            keepAll: true,
            allowMissing: true,
          ])
        }
      }
    }
  }
}
