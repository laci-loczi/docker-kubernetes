pipeline {
    agent any
    environment {
        PATH = "${WORKSPACE}:${PATH}"
        IMAGE_TAG = "my-node-app:${BUILD_NUMBER}"
        IMAGE_LATEST = "my-node-app:latest"
    }
    stages {
        stage('Setup Tools') {
            steps {
                script {
                    // Cache docker and kubectl binaries — only download if missing
                    if (!fileExists('docker/docker')) {
                        sh 'curl -fsSLO https://download.docker.com/linux/static/stable/x86_64/docker-24.0.5.tgz'
                        sh 'tar xzvf docker-24.0.5.tgz --strip 1 -C . docker/docker'
                        sh 'rm -f docker-24.0.5.tgz'
                    }
                    if (!fileExists('kubectl')) {
                        sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                        sh 'chmod +x kubectl'
                    }
                }
            }
        }
        stage('Build Docker Image') {
            steps {
                // Tag with build number for rollback capability
                sh "./docker build -t ${IMAGE_TAG} -t ${IMAGE_LATEST} ./app"
            }
        }
        stage('Deploy to K8s') {
            steps {
                sh './kubectl replace --force -f k8s/deployment.yaml'
            }
        }
    }
    post {
        success {
            // Only prune images older than 24h — keeps last few builds for rollback
            sh './docker image prune -f --filter "until=24h"'
        }
        failure {
            // On failure, remove only the just-built image to reclaim space
            sh "./docker rmi ${IMAGE_TAG} || true"
        }
    }
}